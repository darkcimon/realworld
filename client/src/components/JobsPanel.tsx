import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { Job, WorkAnswerResp, WorkStartResp } from "../types";
import { AnswerInput } from "./AnswerInput";
import { BossPanel } from "./BossPanel";
import { ColleaguePanel } from "./ColleaguePanel";

// README 6.1~6.2: 직업 배정 → 5문제 단위 근무 → 잔업/퇴근 선택 → 정산(일급 지급)
export function JobsPanel({ onBalanceChange }: { onBalanceChange: () => void }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [assignedJobId, setAssignedJobId] = useState<number | null>(null);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [question, setQuestion] = useState<{ no: number; text: string; choices?: string[] } | null>(null);
  const [awaitingDecision, setAwaitingDecision] = useState(false);
  const [lastCorrect, setLastCorrect] = useState<boolean | null>(null);
  const [settleMsg, setSettleMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 배정/정산/퇴근 때마다 올려서 상사 카드가 최신 평가 상태를 다시 불러오게 한다.
  const [bossKey, setBossKey] = useState(0);

  useEffect(() => {
    api.get<Job[]>("/jobs").then(setJobs);
  }, []);

  async function assign(jobId: number) {
    setError(null);
    try {
      await api.post(`/jobs/${jobId}/assign`);
      setAssignedJobId(jobId);
      setBossKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "배정에 실패했습니다.");
    }
  }

  async function startWork() {
    setError(null);
    setLastCorrect(null);
    setAwaitingDecision(false);
    try {
      const r = await api.post<WorkStartResp>("/work/start");
      setSessionId(r.sessionId);
      setQuestion({ no: 1, text: r.question, choices: r.choices });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "근무를 시작할 수 없습니다.");
    }
  }

  async function submitAnswer(answer: string) {
    if (!question || sessionId === null) return;
    try {
      const r = await api.post<WorkAnswerResp>("/work/answer", { sessionId, answer });
      setLastCorrect(r.correct);
      if (r.batchComplete) {
        setAwaitingDecision(true);
        setQuestion(null);
      } else {
        setQuestion({ no: r.questionNo + 1, text: r.nextQuestion!, choices: r.nextChoices });
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "제출에 실패했습니다.");
    }
  }

  async function continueOrLeave(wantsContinue: boolean) {
    if (sessionId === null) return;
    try {
      await api.post("/work/continue-or-leave", { sessionId, continueWork: wantsContinue });
      setAwaitingDecision(false);
      if (wantsContinue) {
        await startWork();
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "선택에 실패했습니다.");
    }
  }

  async function settle() {
    try {
      const r = await api.post<{ settledSessions: number; totalPaid: number }>("/work/settle");
      setSettleMsg(
        r.settledSessions > 0
          ? `${r.settledSessions}건 정산 완료, 총 ${r.totalPaid.toLocaleString()}원 지급`
          : "정산할 근무가 없습니다."
      );
      setBossKey((k) => k + 1);
      onBalanceChange();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "정산에 실패했습니다.");
    }
  }

  return (
    <div className="panel">
      <h3>직장</h3>
      {/* 새로고침 후에도 이미 배정된 직업이 있으면 상사 패널이 알려줘서 근무를 이어갈 수 있다 */}
      <BossPanel refreshKey={bossKey} onJob={(id) => setAssignedJobId((cur) => cur ?? id)} />
      <ColleaguePanel refreshKey={bossKey} onChange={() => setBossKey((k) => k + 1)} />
      {error && <p className="error">{error}</p>}
      <ul className="job-list">
        {jobs.map((j) => (
          <li key={j.id} className={assignedJobId === j.id ? "assigned" : ""}>
            <div>
              <strong>{j.name}</strong>
              {j.tier === "S" && <span className="badge tier-S">S등급</span>}
              <div className="muted">
                일급 {j.pay_min.toLocaleString()}~{j.pay_max.toLocaleString()}원
              </div>
            </div>
            <button className="ghost" onClick={() => assign(j.id)}>
              배정받기
            </button>
          </li>
        ))}
      </ul>

      {assignedJobId && !question && !awaitingDecision && (
        <button onClick={startWork}>근무 시작 (5문제)</button>
      )}

      {question && (
        <div className="work-form">
          <p className="exam-progress">{question.no} / 5</p>
          <p className="exam-question">{question.text}</p>
          <AnswerInput choices={question.choices} onSubmit={submitAnswer} />
          {lastCorrect !== null && (
            <p className={lastCorrect ? "ok-text" : "error"}>{lastCorrect ? "정답!" : "오답"}</p>
          )}
        </div>
      )}

      {awaitingDecision && (
        <div className="work-decision">
          <p>5문제를 완료했습니다. 잔업을 계속할까요?</p>
          <div className="exam-actions">
            <button onClick={() => continueOrLeave(true)}>잔업 계속</button>
            <button className="ghost" onClick={() => continueOrLeave(false)}>
              퇴근
            </button>
          </div>
        </div>
      )}

      <div className="settle-box">
        <button className="ghost" onClick={settle}>
          정산하기 (실제 근무한 만큼 일급 지급)
        </button>
        {settleMsg && <p className="muted">{settleMsg}</p>}
      </div>
    </div>
  );
}
