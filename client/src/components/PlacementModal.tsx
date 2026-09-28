import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { ExamWrongAnswer, PlacementInfo } from "../types";
import { AnswerInput } from "./AnswerInput";

// 배치고사 — 학교급(초/중/고) 단위 10문제 중 8문제 이상 맞히면 해당 학교급 졸업장을 바로 받고
// 고정 보상을 받는다. 학년별 승급 시험을 거치지 않고 학교 과정을 건너뛰는 지름길이다.
interface StartResp {
  questionNo: number;
  total: number;
  question: string;
  choices?: string[];
}
interface AnswerResp {
  correct: boolean;
  finished: boolean;
  nextQuestion?: string;
  nextChoices?: string[];
  correctCount?: number;
  total?: number;
  passed?: boolean;
  wrongAnswers?: ExamWrongAnswer[];
  tier?: string;
  reward?: number;
  nextLevel?: string | null;
}

const won = (n: number) => `${(n / 10_000).toLocaleString()}만원`;

export function PlacementModal({
  info,
  onClose,
  onDone,
}: {
  info: PlacementInfo;
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
  const base = `/school/placement/${info.schoolLevel}`;

  async function start() {
    try {
      const r = await api.post<StartResp>(`${base}/start`);
      setQuestion({ no: r.questionNo, total: r.total, text: r.question, choices: r.choices });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "시험을 시작할 수 없습니다.");
    }
  }

  useEffect(() => {
    start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.schoolLevel]);

  async function submit(answer: string) {
    if (!question) return;
    try {
      const r = await api.post<AnswerResp>(`${base}/answer`, { questionNo: question.no, answer });
      if (r.finished) {
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

  return (
    <div className="modal-backdrop">
      <div className="modal exam-modal">
        <h2>{info.label} 배치고사</h2>
        <p className="muted">
          {info.total}문제 중 {info.passThreshold}문제 이상 맞히면 졸업장과 {won(info.reward)}을 받아요.
        </p>
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

        {result && (
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
                <p>
                  🎓 합격! {info.label} 졸업장(등급 {result.tier})을 받았어요.
                  <br />
                  💰 보상 {won(result.reward ?? info.reward)} 지급 완료
                  {result.nextLevel ? "" : " — 이제 사회로 나갈 수 있어요!"}
                </p>
                <button
                  onClick={() => {
                    onDone();
                    onClose();
                  }}
                >
                  확인
                </button>
              </>
            ) : (
              <>
                <p>{info.passThreshold}문제 이상 맞혀야 합격이에요. 다시 도전해볼까요?</p>
                <div className="exam-actions">
                  <button
                    onClick={() => {
                      setResult(null);
                      start();
                    }}
                  >
                    다시 응시하기
                  </button>
                  <button className="modal-close" onClick={onClose}>
                    닫기
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {!result && (
          <button className="modal-close" onClick={onClose}>
            닫기
          </button>
        )}
      </div>
    </div>
  );
}
