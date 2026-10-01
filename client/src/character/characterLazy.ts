import { lazy } from "react";

// three.js(수백 KB)는 캐릭터를 처음 그릴 때만 내려받는다.
export const CharacterStage = lazy(() => import("./CharacterStage"));
