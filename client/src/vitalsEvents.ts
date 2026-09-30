// 근무(직장 답안, 알바 계산)처럼 서버에서 체력이 줄어드는 동작 뒤에 불러서
// 오른쪽 위 체력 배터리를 바로 갱신하게 한다(App이 듣고 /town/vitals를 다시 받는다).
const EVENT = "vitals:refresh";

export function requestVitalsRefresh(): void {
  window.dispatchEvent(new Event(EVENT));
}

export function onVitalsRefresh(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
