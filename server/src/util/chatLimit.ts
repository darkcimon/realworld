// 모든 채팅(학교 채팅방, 1:1 DM, 감옥, 개인 수업 질문, 직장 동료 대화)에 공통으로 적용하는 글자 수 상한.
// 클라이언트 입력창도 같은 값(client/src/constants.ts의 MAX_CHAT_LEN)으로 막지만, 우회 요청에 대비해
// 서버가 최종적으로 확인한다. 잘라서 받지 않고 거절한다 — 말이 중간에 잘려 뜻이 바뀌는 일을 막기 위해서다.
export const MAX_CHAT_LEN = 300;

/** 너무 길면 사용자에게 보여줄 오류 문구를, 괜찮으면 null을 돌려준다. */
export function chatLengthError(text: string): string | null {
  return text.length > MAX_CHAT_LEN ? `메시지는 한 번에 ${MAX_CHAT_LEN}자까지 보낼 수 있어요. (현재 ${text.length}자)` : null;
}
