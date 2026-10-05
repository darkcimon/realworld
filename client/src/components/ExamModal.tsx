import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { ExamWrongAnswer } from "../types";
import { AnswerInput } from "./AnswerInput";
import { feedback } from "../feedback";

// 승급 시험 — 10문제 중 7개 이상 정답 시 승급 여부를 본인이 선택. 방이 잠겨 있지 않은 한
// 언제든 응시할 수 있다(별도의 참여 시간 제한 없음). 결과 화면에서는 틀린 문제의 정답과
// 이유를 함께 보여줘 복습할 수 있게 한다.
interface StartResp {
  questionNo: number;
  total: number;
  question: string;
  choices?: string[];
}
interface AnswerResp {
  correct: boolean;
  questionNo: number;
  correctAnswer: string;
  explanation: string;
  finished: boolean;
  nextQuestion?: string;
  nextChoices?: string[];
  correctCount?: number;
  total?: number;
  passed?: boolean;
  reward?: number;
  rewardNote?: string | null;
  wrongAnswers?: ExamWrongAnswer[];
}

export function ExamModal({
  roomId,
  onClose,
  onDone,
}: {
  roomId: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState<{
    no: number;
    total: number;
    text: string;
    choices?: string[];
  } | null>(null);
  const [result, setResult] = useState<AnswerResp | null>(null);
  const [decision, setDecision] = useState<string | null>(null);

  useEffect(() => {
    api
      .post<StartResp>(`/school/rooms/${roomId}/exam/start`)
      .then((r) =>
        setQuestion({ no: r.questionNo, total: r.total, text: r.question, choices: r.choices })
      )
      .catch((e) => setError(e instanceof ApiError ? e.message : "시험을 시작할 수 없습니다."));
  }, [roomId]);

  async function submit(answer: string) {
    if (!question) return;
    try {
      const r = await api.post<AnswerResp>(`/school/rooms/${roomId}/exam/answer`, {
        questionNo: question.no,
        answer,
      });
      if (r.finished) {
        feedback(r.passed ? "jackpot" : "wrong"); // 문제마다 정답은 알려주지 않고 끝에 결과만
        setResult(r);
        setQuestion(null);
      } else {
        setQuestion({
          no: question.no + 1,
          total: question.total,
          text: r.nextQuestion!,
          choices: r.nextChoices,
        });
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "제출에 실패했습니다.");
    }
  }

  async function choose(advance: boolean) {
    try {
      const r = await api.post<{ retake?: boolean }>(`/school/rooms/${roomId}/promote`, { advance });
      setDecision(advance ? (r.retake ? "retake" : "advance") : "stay");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "선택에 실패했습니다.");
    }
  }

  async function retry() {
    setResult(null);
    try {
      const r = await api.post<StartResp>(`/school/rooms/${roomId}/exam/start`);
      setQuestion({ no: r.questionNo, total: r.total, text: r.question, choices: r.choices });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "재응시에 실패했습니다.");
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal exam-modal">
        <h2>승급 시험</h2>
        {error && <p className="error">{error}</p>}

        {question && (
          <div>
            <p className="exam-progress">
              {question.no} / {question.total}
            </p>
            <p className="exam-question">{question.text}</p>
            <AnswerInput choices={question.choices} onSubmit={submit} />
          </div>
        )}

        {result && !decision && (
          <div className="exam-result">
            <p>
              {result.correctCount} / {result.total} 정답
            </p>

            {!!result.wrongAnswers?.length && (
              <div className="exam-review">
                <p className="exam-review-title">틀린 문제 다시 보기</p>
                <ul>
                  {result.wrongAnswers.map((w) => (
                    <li key={w.questionNo}>
                      <p className="exam-review-q">
                        {w.questionNo}. {w.question}
                      </p>
                      <p className="exam-review-your">
                        내 답: <span>{w.yourAnswer || "(미입력)"}</span>
                      </p>
                      <p className="exam-review-correct">
                        정답: <span>{w.correctAnswer}</span>
                      </p>
                      <p className="exam-review-explanation">💡 {w.explanation}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {result.passed ? (
              <>
                <p>승급 자격을 얻었습니다! 승급하시겠어요?</p>
                {!!result.reward && <p>💰 합격 보상 {result.reward.toLocaleString()}원이 지급되었어요!</p>}
                {result.rewardNote && <p className="muted">{result.rewardNote}</p>}
                <div className="exam-actions">
                  <button onClick={() => choose(true)}>승급한다</button>
                  <button onClick={() => choose(false)}>이 학년에 머무른다</button>
                </div>
              </>
            ) : (
              <>
                <p>7문제 이상 맞춰야 승급 시험에 통과합니다.</p>
                <button onClick={retry}>다시 응시하기</button>
              </>
            )}
          </div>
        )}

        {decision && (
          <div className="exam-result">
            <p>{decision === "advance"
                ? "승급을 선택했습니다!"
                : decision === "retake"
                ? "이미 지나온 학년이라 학년은 그대로이고, 성적만 이번 결과로 갱신했어요."
                : "같은 학년에 머무르기로 했습니다."}</p>
            <button
              onClick={() => {
                onDone();
                onClose();
              }}
            >
              확인
            </button>
          </div>
        )}

        {!result && !decision && (
          <button className="modal-close" onClick={onClose}>
            닫기
          </button>
        )}
      </div>
    </div>
  );
}
