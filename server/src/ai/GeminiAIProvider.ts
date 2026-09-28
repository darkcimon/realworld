// 개인 수업(1:1) AI 선생님 역할을 비용 없이 실제 LLM으로 구현하기 위한 Provider.
// Google Gemini API 무료 티어(요금 없음, aistudio.google.com에서 무료 키 발급)를 사용한다.
// ClaudeAIProvider와 동일하게 "학년 고정 페르소나 + 실패 시 MockAIProvider로 조용히 폴백"
// 패턴을 그대로 따르고, 프롬프트 문구도 promptHelpers.ts를 공유한다.
//
// 2026-08 기준 Gemini API는 REST가 새 Interactions API(POST /v1beta/interactions)로
// 바뀌어 있어(과거의 generateContent와 다름) 그 형태로 호출한다. 별도 SDK 의존성 없이
// Node 22+ 내장 fetch만 사용한다.
//
// 2026-08-30: 실제로 curl로 직접 찍어보니 네트워크/구현 문제가 아니라 모델 이름 문제였다.
// gemini-3.7-flash는 무료 티어 쿼터가 극도로 작아(하루 5회) 바로 429(quota exceeded)가
// 나서 매번 MockAIProvider로 폴백되고 있었다. 같은 키로 gemini-3.6-flash를 호출하면
// 정상 응답이 온다 — Google이 404 에러 메시지에서도 3.6-flash로의 마이그레이션을
// 권장하고 있어(구 모델 gemini-2.0-flash deprecated 안내), 이 모델로 교체한다.
//
// 2026-08-30(추가): 이 게임의 AI 선생님 응답은 짧은 채팅 답변 수준이라 굳이 3.6-flash 같은
// 상위 모델이 필요 없어서, 훨씬 저렴한 Lite 등급으로 다시 내렸다. 처음엔
// gemini-2.5-flash-lite(가격표상 가장 저렴, $0.10/$0.40)를 시도했는데 실제로 호출해보니
// "신규 사용자에게는 더 이상 제공되지 않음, gemini-3.5-flash-lite로 옮기라"는 404가 떴다
// — 그래서 그 안내대로 gemini-3.5-flash-lite($0.30/$2.50)로 정착했다. 프롬프트 캐싱은 이
// Interactions API가 "암묵적 캐싱"만 지원하고(명시적 cache_control 파라미터 자체가 없음),
// 그마저도 Gemini 2.5+ 모델 기준 요청당 최소 2,048토큰 이상이어야 캐시가 걸리는데 —
// 우리 프롬프트는 system+user 합쳐도 500토큰이 안 돼서 애초에 캐싱 적용 대상이 아니다.
//
// 2026-08-30(월 예산 상한): 비용이 예상보다 커지는 걸 막기 위해, 이번 달 누적 호출 비용이
// MONTHLY_BUDGET_USD를 넘으면 그 순간부터 실제 API 호출 자체를 하지 않고 곧바로
// MockAIProvider(고정 응답)로 넘어가게 한다. 비용은 매 호출 응답에 포함된 실제 토큰 수
// (usage.total_input_tokens/total_output_tokens)로 계산해 db.ts의 ai_usage 테이블에
// 누적하고, 달이 바뀌면(period='YYYY-MM') 자동으로 새로 시작된다. 가격 상수는 위 MODEL의
// 현재 단가(2026-08 기준)이니, MODEL을 바꾸면 이 상수도 같이 바꿔야 한다.
import type {
  AIProvider,
  BoardCommand,
  ConversationMemory,
  ConversationTurn,
  ExamQuestion,
  LessonReply,
  LessonStart,
  StudentUtterance,
} from "./AIProvider.js";
import { addAiCostUsd, getMonthlyAiCostUsd } from "../db.js";
import { MockAIProvider } from "./MockAIProvider.js";
import { parseLessonReplyJson, parseLessonStartJson } from "./lessonJson.js";
import {
  lessonAnswerUserPrompt,
  lessonStartUserPrompt,
  lessonSystemPrompt,
  summarySystemPrompt,
  summaryUserPrompt,
  npcVoiceSystemPrompt,
  npcVoiceUserPrompt,
  teacherSystemPrompt,
  teacherUserPrompt,
  topicSystemPrompt,
  topicUserPrompt,
} from "./promptHelpers.js";

const MODEL = "gemini-3.5-flash-lite"; // 저비용 Lite 등급(2026-08 기준, $0.30/$2.50 per 1M) — gemini-2.5-flash-lite는 신규 사용자에게 제공 중단됨
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const TIMEOUT_MS = 20000;

const PRICE_PER_1M_INPUT_USD = 0.3; // gemini-3.5-flash-lite 기준(MODEL 바꾸면 같이 갱신)
const PRICE_PER_1M_OUTPUT_USD = 2.5;
const MONTHLY_BUDGET_USD = 5;

interface InteractionsResponse {
  // `output_text`는 Google GenAI SDK가 붙여주는 편의 필드일 뿐, 실제 REST 응답(우리는 SDK 없이
  // 직접 fetch)에는 없다 — 실제로는 steps[] 중 type:"model_output"인 단계의 content[]에서
  // type:"text"인 블록의 text를 모아야 한다(중간에 type:"thought" 같은 추론 단계도 섞여 있다).
  output_text?: string;
  steps?: { type: string; content?: { type: string; text?: string }[] }[];
  error?: { message?: string; code?: string };
  usage?: { total_input_tokens?: number; total_output_tokens?: number; total_thought_tokens?: number };
}

function extractText(data: InteractionsResponse): string {
  if (data.output_text?.trim()) return data.output_text.trim();
  const parts: string[] = [];
  for (const step of data.steps ?? []) {
    if (step.type !== "model_output") continue;
    for (const block of step.content ?? []) {
      if (block.type === "text" && block.text) parts.push(block.text);
    }
  }
  return parts.join(" ").trim();
}

export class GeminiAIProvider implements AIProvider {
  private readonly fallback = new MockAIProvider();
  private warned = false;

  private warnOnce(context: string, err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[ai] Gemini API 호출 실패(${context}) — 이후 AI 선생님 응답은 MockAIProvider(고정 응답)로 대체합니다:`,
      message
    );
  }

  private async complete(systemInstruction: string, input: string, maxOutputTokens?: number): Promise<string> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY가 설정되어 있지 않습니다.");

    const spent = getMonthlyAiCostUsd();
    if (spent >= MONTHLY_BUDGET_USD) {
      throw new Error(
        `이번 달 AI 호출 비용이 예산($${MONTHLY_BUDGET_USD})을 넘어(현재 $${spent.toFixed(
          4
        )}) 실제 호출을 건너뜁니다.`
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          system_instruction: systemInstruction,
          input,
          generation_config: {
            temperature: 0.9,
            ...(maxOutputTokens ? { max_output_tokens: maxOutputTokens } : {}),
          },
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as InteractionsResponse;
    if (data.error) {
      throw new Error(`Gemini API 오류: ${data.error.message ?? JSON.stringify(data.error)}`);
    }
    const text = extractText(data);
    if (!text) throw new Error("응답에서 텍스트를 찾지 못했습니다.");

    // 실제 청구 대상인 입력/추론(thought)/출력 토큰 수를 그대로 써서 이번 호출 비용을 계산해
    // 월 누적치에 더한다 — 추정치가 아니라 응답에 찍힌 실제 토큰 수를 쓰므로 예산 판정이 정확하다.
    const inputTokens = data.usage?.total_input_tokens ?? 0;
    const outputTokens = (data.usage?.total_output_tokens ?? 0) + (data.usage?.total_thought_tokens ?? 0);
    const cost = (inputTokens / 1_000_000) * PRICE_PER_1M_INPUT_USD + (outputTokens / 1_000_000) * PRICE_PER_1M_OUTPUT_USD;
    addAiCostUsd(cost);

    return text;
  }

  async pickDiscussionTopic(
    schoolLevel: string,
    grade: number,
    recentMessages: StudentUtterance[],
    avoidTopics: string[] = []
  ): Promise<string> {
    try {
      const text = await this.complete(
        topicSystemPrompt(schoolLevel, grade),
        topicUserPrompt(schoolLevel, grade, recentMessages, avoidTopics)
      );
      const firstLine = text.split("\n")[0].trim().replace(/^["'“”]|["'“”]$/g, "");
      if (!firstLine) throw new Error("빈 주제 응답");
      return firstLine.slice(0, 60);
    } catch (err) {
      this.warnOnce("pickDiscussionTopic", err);
      return this.fallback.pickDiscussionTopic(schoolLevel, grade, recentMessages, avoidTopics);
    }
  }

  async npcLine(npc: "manager" | "boss", situation: string, baseLine: string): Promise<string> {
    try {
      const text = await this.complete(npcVoiceSystemPrompt(npc), npcVoiceUserPrompt(situation, baseLine), 200);
      return text.split(/\r?\n/)[0].trim().replace(/^["'“”]|["'“”]$/g, "") || baseLine;
    } catch (err) {
      this.warnOnce("npcLine", err);
      return baseLine;
    }
  }

  async teacherReplyToBatch(
    topic: string,
    utterances: StudentUtterance[],
    schoolLevel: string,
    grade: number,
    memory?: ConversationMemory | null
  ): Promise<string> {
    if (utterances.length === 0) {
      return this.fallback.teacherReplyToBatch(topic, utterances, schoolLevel, grade, memory);
    }
    try {
      return await this.complete(
        teacherSystemPrompt(schoolLevel, grade),
        teacherUserPrompt(topic, utterances, memory)
      );
    } catch (err) {
      this.warnOnce("teacherReplyToBatch", err);
      return this.fallback.teacherReplyToBatch(topic, utterances, schoolLevel, grade, memory);
    }
  }

  async summarizeConversation(
    schoolLevel: string,
    grade: number,
    topic: string,
    previousSummary: string | null,
    turns: ConversationTurn[]
  ): Promise<string> {
    try {
      return await this.complete(
        summarySystemPrompt(schoolLevel, grade),
        summaryUserPrompt(topic, previousSummary, turns)
      );
    } catch (err) {
      this.warnOnce("summarizeConversation", err);
      return this.fallback.summarizeConversation(schoolLevel, grade, topic, previousSummary, turns);
    }
  }

  async startLesson(schoolLevel: string, grade: number, avoidTopics: string[] = []): Promise<LessonStart> {
    try {
      const text = await this.complete(
        lessonSystemPrompt(schoolLevel, grade),
        lessonStartUserPrompt(schoolLevel, grade, avoidTopics),
        900
      );
      return parseLessonStartJson(text);
    } catch (err) {
      this.warnOnce("startLesson", err);
      return this.fallback.startLesson(schoolLevel, grade, avoidTopics);
    }
  }

  async answerLessonQuestion(
    topic: string,
    schoolLevel: string,
    grade: number,
    question: string,
    memory: ConversationMemory | null,
    currentBoard: BoardCommand[]
  ): Promise<LessonReply> {
    try {
      const text = await this.complete(
        lessonSystemPrompt(schoolLevel, grade),
        lessonAnswerUserPrompt(topic, question, memory, currentBoard),
        900
      );
      return parseLessonReplyJson(text);
    } catch (err) {
      this.warnOnce("answerLessonQuestion", err);
      return this.fallback.answerLessonQuestion(topic, schoolLevel, grade, question, memory, currentBoard);
    }
  }

  getExamQuestions(schoolLevel: string, grade: number): ExamQuestion[] {
    return this.fallback.getExamQuestions(schoolLevel, grade);
  }

  getPlacementQuestions(schoolLevel: string): ExamQuestion[] {
    return this.fallback.getPlacementQuestions(schoolLevel);
  }

  getWorkQuestions(): ExamQuestion[] {
    return this.fallback.getWorkQuestions();
  }

  gradeAnswer(question: ExamQuestion, submittedAnswer: string): boolean {
    return this.fallback.gradeAnswer(question, submittedAnswer);
  }
}
