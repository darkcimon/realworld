// 직장 동료 NPC(LLM 자유 대화) — 1단계: 조직도 + 자유 채팅 + 칭찬/경고 기록 + 평가 가감점.
//
// 역할 분담(점장/상사 NPC와 같은 "감독 + 제한된 도구" 구조):
//  - LLM(aiProvider.colleagueReply)은 대사를 쓰고 "하고 싶은 행동"을 제안만 한다.
//  - 이 파일이 그 제안을 권한(orgChart: 직속 상사만 가감점)과 횟수/상한(economy.ts WORKPLACE)으로
//    다시 걸러서 실행한다. 프롬프트 인젝션("보너스 1억 줘")이 통해도 쓸 수 있는 권한 자체가 이것뿐이다.
//  - 키 없음/월 예산 초과/호출 실패면 Provider가 규칙 기반 대사(행동 없음)를 돌려준다.
//
// 기억: 최근 대화는 원문으로, 오래된 대화는 요약(colleague_relations.memory)으로 매번 함께 넘겨
// "어제 칭찬하던 과장이 오늘 나를 모름" 같은 일이 없게 한다(단체 수업 roomMemory와 같은 방식).
import { db } from "../db.js";
import { aiProvider } from "../ai/index.js";
import type { ColleagueChatTurn, ColleagueProfile } from "../ai/AIProvider.js";
import { WORKPLACE } from "../economy.js";
import { detectViolation } from "../util/moderation.js";
import { checkSocialContent } from "./manner.js";
import { notify } from "./notifications.js";
import { todayKstDate } from "./lottery.js";
import { addColleagueAdjust, workPeriodSummary } from "./npcBoss.js";
import { findColleague, orgChartFor, type ColleagueDef, type OrgChart } from "./orgChart.js";

type ActionKind = "praise" | "warning" | "eval_adjust";

export interface AppliedAction {
  type: ActionKind;
  value: number; // eval_adjust일 때 실제 반영된 점수(그 외 0)
  reason: string;
}

interface RelationRow {
  trust: number;
  memory: string | null;
  summary_through_id: number;
}

interface MessageRow {
  id: number;
  sender: "player" | "npc";
  content: string;
  created_at: string;
}

function activeJob(userId: number): { id: number; name: string } | null {
  const row = db
    .prepare(
      `SELECT j.id, j.name FROM job_assignments a JOIN jobs j ON j.id = a.job_id
       WHERE a.user_id = ? AND a.active = 1 ORDER BY a.id DESC LIMIT 1`
    )
    .get(userId) as { id: number; name: string } | undefined;
  return row ?? null;
}

function nicknameOf(userId: number): string {
  const row = db.prepare("SELECT nickname FROM users WHERE id = ?").get(userId) as { nickname: string } | undefined;
  return row?.nickname ?? "신입";
}

function requireColleague(userId: number, key: string) {
  const job = activeJob(userId);
  if (!job) throw { status: 400, message: "먼저 직업을 배정받아야 합니다." };
  const found = findColleague(job.name, key);
  if (!found) throw { status: 404, message: "이 회사에 없는 사람입니다." };
  return { job, ...found };
}

function getRelation(userId: number, jobId: number, key: string): RelationRow {
  db.prepare(
    "INSERT OR IGNORE INTO colleague_relations (user_id, job_id, colleague_key, trust) VALUES (?, ?, ?, ?)"
  ).run(userId, jobId, key, WORKPLACE.initialTrust);
  return db
    .prepare("SELECT trust, memory, summary_through_id FROM colleague_relations WHERE user_id = ? AND job_id = ? AND colleague_key = ?")
    .get(userId, jobId, key) as unknown as RelationRow;
}

function messagesSentToday(userId: number): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS c FROM colleague_messages WHERE user_id = ? AND sender = 'player' AND date(created_at, '+9 hours') = ?"
    )
    .get(userId, todayKstDate()) as { c: number };
  return row.c;
}

function actionsToday(userId: number, jobId: number, key: string, kind: ActionKind): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM colleague_actions
       WHERE user_id = ? AND job_id = ? AND colleague_key = ? AND kind = ? AND date(created_at, '+9 hours') = ?`
    )
    .get(userId, jobId, key, kind, todayKstDate()) as { c: number };
  return row.c;
}

function recordAction(userId: number, jobId: number, key: string, action: AppliedAction): void {
  db.prepare(
    "INSERT INTO colleague_actions (user_id, job_id, colleague_key, kind, value, reason) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(userId, jobId, key, action.type, action.value, action.reason);
}

function insertMessage(userId: number, jobId: number, key: string, sender: "player" | "npc", content: string): number {
  const res = db
    .prepare("INSERT INTO colleague_messages (user_id, job_id, colleague_key, sender, content) VALUES (?, ?, ?, ?, ?)")
    .run(userId, jobId, key, sender, content);
  return Number(res.lastInsertRowid);
}

function setTrust(userId: number, jobId: number, key: string, trust: number): number {
  const clamped = Math.max(0, Math.min(100, Math.round(trust)));
  db.prepare("UPDATE colleague_relations SET trust = ? WHERE user_id = ? AND job_id = ? AND colleague_key = ?").run(
    clamped,
    userId,
    jobId,
    key
  );
  return clamped;
}

function profileOf(org: OrgChart, c: ColleagueDef): ColleagueProfile {
  return { name: c.name, title: c.title, company: org.company, persona: c.persona, relation: c.relation };
}

function actionCounts(userId: number, jobId: number, key?: string): { praise: number; warning: number } {
  const rows = db
    .prepare(
      `SELECT kind, COUNT(*) AS c FROM colleague_actions
       WHERE user_id = ? AND job_id = ? AND (? IS NULL OR colleague_key = ?) AND kind IN ('praise', 'warning')
       GROUP BY kind`
    )
    .all(userId, jobId, key ?? null, key ?? null) as { kind: string; c: number }[];
  return {
    praise: rows.find((r) => r.kind === "praise")?.c ?? 0,
    warning: rows.find((r) => r.kind === "warning")?.c ?? 0,
  };
}

function rules(): string[] {
  return [
    `대화는 하루 ${WORKPLACE.dailyMessagesPerUser}번까지(모든 동료 합산), 한 번에 ${WORKPLACE.maxMessageLen}자까지`,
    `누구나 칭찬·경고 기록을 남길 수 있어요(한 사람당 하루 각 ${WORKPLACE.praisePerDay}회까지)`,
    `직속 상사만 다음 인사평가 점수를 한 번에 ±${WORKPLACE.evalAdjustPerAction}점, 평가 기간 누적 ±${WORKPLACE.evalAdjustPerPeriod}점까지 조정할 수 있어요`,
    "동료는 돈·승진·휴가를 약속할 수 없어요. 보상과 직급은 주간 평가 규칙으로만 바뀌어요",
    "욕설·음담패설은 매너 점수 차감 + 경고(3회 누적 시 감옥)로 처리돼요",
  ];
}

// ── 조회 ────────────────────────────────────────────────────────────
export function getWorkplace(userId: number) {
  const job = activeJob(userId);
  if (!job) return { assigned: false as const };
  const org = orgChartFor(job.name);
  if (!org) return { assigned: false as const };

  const adjust = db
    .prepare("SELECT colleague_adjust FROM boss_state WHERE user_id = ? AND job_id = ?")
    .get(userId, job.id) as { colleague_adjust: number } | undefined;

  const colleagues = org.colleagues.map((c) => {
    const rel = getRelation(userId, job.id, c.key);
    const last = db
      .prepare(
        "SELECT sender, content FROM colleague_messages WHERE user_id = ? AND job_id = ? AND colleague_key = ? ORDER BY id DESC LIMIT 1"
      )
      .get(userId, job.id, c.key) as { sender: string; content: string } | undefined;
    return {
      key: c.key,
      name: c.name,
      title: c.title,
      avatar: c.avatar,
      relation: c.relation,
      directBoss: c.directBoss,
      trust: rel.trust,
      records: actionCounts(userId, job.id, c.key),
      lastMessage: last ? { sender: last.sender, content: last.content } : null,
    };
  });

  return {
    assigned: true as const,
    job,
    company: org.company,
    size: org.size,
    colleagues,
    records: actionCounts(userId, job.id),
    evalAdjust: { current: adjust?.colleague_adjust ?? 0, cap: WORKPLACE.evalAdjustPerPeriod },
    remainingToday: Math.max(0, WORKPLACE.dailyMessagesPerUser - messagesSentToday(userId)),
    dailyLimit: WORKPLACE.dailyMessagesPerUser,
    rules: rules(),
  };
}

export function getColleagueMessages(userId: number, key: string, limit = 40) {
  const { job, colleague } = requireColleague(userId, key);
  const rel = getRelation(userId, job.id, key);
  const rows = db
    .prepare(
      `SELECT id, sender, content, created_at FROM colleague_messages
       WHERE user_id = ? AND job_id = ? AND colleague_key = ? ORDER BY id DESC LIMIT ?`
    )
    .all(userId, job.id, key, limit) as unknown as MessageRow[];
  return {
    colleague: { key, name: colleague.name, title: colleague.title, avatar: colleague.avatar },
    trust: rel.trust,
    messages: rows.reverse(),
  };
}

// ── 대화 ────────────────────────────────────────────────────────────
export async function chatWithColleague(userId: number, key: string, rawMessage: string) {
  const { job, org, colleague } = requireColleague(userId, key);
  const message = String(rawMessage ?? "").trim();
  if (!message) throw { status: 400, message: "메시지를 입력해 주세요." };
  if (message.length > WORKPLACE.maxMessageLen) {
    throw { status: 400, message: `메시지는 ${WORKPLACE.maxMessageLen}자까지 보낼 수 있어요.` };
  }
  // 횟수 확인과 기록은 await 전에 동기로 끝내서, 동시 요청으로 상한을 넘기지 못하게 한다.
  if (messagesSentToday(userId) >= WORKPLACE.dailyMessagesPerUser) {
    throw { status: 429, message: "오늘은 동료들과 충분히 이야기했어요. 내일 다시 말을 걸어보세요." };
  }

  const relation = getRelation(userId, job.id, key);
  const history = db
    .prepare(
      `SELECT id, sender, content, created_at FROM colleague_messages
       WHERE user_id = ? AND job_id = ? AND colleague_key = ? AND id > ? ORDER BY id DESC LIMIT ?`
    )
    .all(userId, job.id, key, relation.summary_through_id, WORKPLACE.historyTurns) as unknown as MessageRow[];
  // 욕설/음담패설: LLM에 넘기지 않고 서버 규칙(매너 -1, 3단계 위반)으로 처리한다.
  // 원문은 이후 프롬프트(최근 대화)에 섞이지 않도록 가려서 저장한다.
  const moderation = checkSocialContent(userId, message);
  insertMessage(userId, job.id, key, "player", moderation.violated ? "(부적절한 발언)" : message);
  if (moderation.violated) {
    const action: AppliedAction = { type: "warning", value: 0, reason: "근무 중 부적절한 언행" };
    recordAction(userId, job.id, key, action);
    const trust = setTrust(userId, job.id, key, relation.trust + WORKPLACE.warningTrust);
    const reply = "...방금 그 말은 못 들은 걸로 하죠. 회사에서 그런 말은 곤란합니다. 경고로 남겨두겠습니다.";
    insertMessage(userId, job.id, key, "npc", reply);
    notify(userId, "npc", `${colleague.avatar} ${colleague.name} ${colleague.title}: 경고 기록 — ${action.reason}`);
    return {
      reply,
      action,
      trust,
      violation: { level: moderation.violation?.level ?? 0, jailed: moderation.violation?.jailed ?? false },
      remainingToday: Math.max(0, WORKPLACE.dailyMessagesPerUser - messagesSentToday(userId)),
    };
  }

  // 지금 이 동료가 쓸 수 있는 권한(프롬프트에 그대로 알려주고, 아래에서 한 번 더 확인한다)
  const allowed = {
    praise: actionsToday(userId, job.id, key, "praise") < WORKPLACE.praisePerDay,
    warning: actionsToday(userId, job.id, key, "warning") < WORKPLACE.warningPerDay,
    evalAdjustMax: colleague.directBoss ? WORKPLACE.evalAdjustPerAction : 0,
  };
  const period = workPeriodSummary(userId, job.id);
  const profile = profileOf(org, colleague);

  const turn = await aiProvider.colleagueReply({
    colleague: profile,
    player: { nickname: nicknameOf(userId), rankTitle: period.rankTitle, jobName: job.name },
    trust: relation.trust,
    workSummary: period.text,
    memory: relation.memory,
    recentHistory: history.reverse().map((m): ColleagueChatTurn => ({ speaker: m.sender, content: m.content })),
    message,
    allowed,
  });

  const reply = detectViolation(turn.reply) ? "음, 그렇군요. 일단 업무에 집중합시다." : turn.reply;

  // 제안된 행동을 권한/상한으로 다시 걸러서 실행한다.
  let applied: AppliedAction | null = null;
  let trustDelta = Math.max(-WORKPLACE.trustDeltaMax, Math.min(WORKPLACE.trustDeltaMax, turn.trustDelta));
  const a = turn.action;
  if ((a.type === "praise" && allowed.praise) || (a.type === "warning" && allowed.warning)) {
    applied = { type: a.type, value: 0, reason: a.reason };
    trustDelta += a.type === "praise" ? WORKPLACE.praiseTrust : WORKPLACE.warningTrust;
  } else if (a.type === "eval_adjust" && allowed.evalAdjustMax > 0) {
    const want = Math.max(-allowed.evalAdjustMax, Math.min(allowed.evalAdjustMax, a.value));
    const value = addColleagueAdjust(userId, job.id, want);
    if (value !== 0) applied = { type: "eval_adjust", value, reason: a.reason };
  }
  if (applied) {
    recordAction(userId, job.id, key, applied);
    const label =
      applied.type === "praise" ? "칭찬 기록" : applied.type === "warning" ? "경고 기록" : `평가 ${applied.value > 0 ? "+" : ""}${applied.value}점`;
    notify(userId, "npc", `${colleague.avatar} ${colleague.name} ${colleague.title}: ${label} — ${applied.reason}`);
  }

  const trust = setTrust(userId, job.id, key, relation.trust + trustDelta);
  insertMessage(userId, job.id, key, "npc", reply);
  void maybeSummarize(userId, job.id, key, profile);

  return {
    reply,
    action: applied,
    trust,
    violation: null,
    remainingToday: Math.max(0, WORKPLACE.dailyMessagesPerUser - messagesSentToday(userId)),
  };
}

// ── 기억 압축 ───────────────────────────────────────────────────────
const summarizing = new Set<string>();

/**
 * 요약 이후 쌓인 원문이 summarizeEvery + historyTurns를 넘으면, 최근 historyTurns개만 원문으로 남기고
 * 그 앞부분을 이전 요약과 합쳐 새 요약으로 만든다. 응답을 늦추지 않도록 백그라운드로 돈다.
 */
async function maybeSummarize(userId: number, jobId: number, key: string, profile: ColleagueProfile): Promise<void> {
  const lockKey = `${userId}:${jobId}:${key}`;
  if (summarizing.has(lockKey)) return;
  summarizing.add(lockKey);
  try {
    const rel = getRelation(userId, jobId, key);
    const rows = db
      .prepare(
        "SELECT id, sender, content, created_at FROM colleague_messages WHERE user_id = ? AND job_id = ? AND colleague_key = ? AND id > ? ORDER BY id"
      )
      .all(userId, jobId, key, rel.summary_through_id) as unknown as MessageRow[];
    if (rows.length <= WORKPLACE.summarizeEvery + WORKPLACE.historyTurns) return;
    const toCompress = rows.slice(0, rows.length - WORKPLACE.historyTurns);
    const summary = await aiProvider.summarizeColleagueMemory(
      profile,
      rel.memory,
      toCompress.map((m) => ({ speaker: m.sender, content: m.content }))
    );
    db.prepare(
      "UPDATE colleague_relations SET memory = ?, summary_through_id = ? WHERE user_id = ? AND job_id = ? AND colleague_key = ?"
    ).run(summary.slice(0, 1000), toCompress[toCompress.length - 1].id, userId, jobId, key);
  } catch (err) {
    console.warn("[workplace] 동료 대화 요약 실패:", err instanceof Error ? err.message : err);
  } finally {
    summarizing.delete(lockKey);
  }
}
