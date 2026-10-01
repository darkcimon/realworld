// AI 선생님 / 시험·근무 문제 출제 진입점.
// GEMINI_API_KEY가 있으면 무료 티어인 Gemini를 우선 사용하고(비용 없음), 없고
// ANTHROPIC_API_KEY만 있으면 Claude를 쓰고(유료), 둘 다 없으면 MockAIProvider(고정 응답)로
// 동작한다. 실제 호출이 실패해도(키 오류, 네트워크 오류, 무료 한도 초과 등) 각 Provider가
// 내부적으로 MockAIProvider로 조용히 대체하므로 서버 동작 자체는 항상 안전하다.
import type { AIProvider } from "./AIProvider.js";
import { MockAIProvider } from "./MockAIProvider.js";
import { ClaudeAIProvider } from "./ClaudeAIProvider.js";
import { GeminiAIProvider } from "./GeminiAIProvider.js";
import { plainMath, plainMathBoard } from "./plainMath.js";

function selectProvider(): AIProvider {
  if (process.env.GEMINI_API_KEY) return new GeminiAIProvider();
  if (process.env.ANTHROPIC_API_KEY) return new ClaudeAIProvider();
  return new MockAIProvider();
}

// 선생님 답변(채팅·칠판)은 화면에 글자 그대로 나가므로, LLM이 LaTeX 수식($a_n$ 등)을 섞어도
// 읽기 쉬운 텍스트로 바꿔서 내보낸다(어느 Provider든 같은 후처리를 거치도록 여기서 감싼다).
function withPlainMath(p: AIProvider): AIProvider {
  return Object.assign(Object.create(p), {
    async teacherReplyToBatch(...args: Parameters<AIProvider["teacherReplyToBatch"]>) {
      return plainMath(await p.teacherReplyToBatch(...args));
    },
    async startLesson(...args: Parameters<AIProvider["startLesson"]>) {
      const r = await p.startLesson(...args);
      return { ...r, message: plainMath(r.message), board: plainMathBoard(r.board) };
    },
    async answerLessonQuestion(...args: Parameters<AIProvider["answerLessonQuestion"]>) {
      const r = await p.answerLessonQuestion(...args);
      return { ...r, message: plainMath(r.message), board: r.board && plainMathBoard(r.board) };
    },
  }) as AIProvider;
}

export const aiProvider: AIProvider = withPlainMath(selectProvider());
