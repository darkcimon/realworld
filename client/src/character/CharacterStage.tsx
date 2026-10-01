import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { buildCharacter, type BuiltCharacter } from "./characterModel";
import type { CharacterConfig } from "./options";

// 캐릭터 3D 무대: 드래그로 돌리고, 가만히 두면 천천히 돈다. 설정이 바뀌면 캐릭터만 다시 조립한다.
// three.js가 크므로 React.lazy로만 불러온다(characterLazy.ts).
const ANIMS: [string, string][] = [
  ["idle", "가만히"],
  ["walk", "걷기"],
  ["emote-yes", "인사"],
  ["jump", "점프"],
  ["sit", "앉기"],
];
const ONCE = new Set(["emote-yes", "jump"]);

export default function CharacterStage({
  config,
  photoUrl,
  showActions = false,
  onHairLock,
}: {
  config: CharacterConfig;
  photoUrl: string | null;
  showActions?: boolean;
  onHairLock?: (locked: boolean) => void; // 지금 헤어 색을 바꿀 수 없는 조합인지 알려준다
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const world = useRef<{
    scene: THREE.Scene;
    current: BuiltCharacter | null;
    mixer: THREE.AnimationMixer | null;
    actions: Record<string, THREE.AnimationAction>;
    yaw: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [anim, setAnim] = useState("idle");

  // 렌더러·카메라·조명은 한 번만 만든다.
  useEffect(() => {
    const mount = mountRef.current!;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 20);
    camera.position.set(0, 0.62, 2.55);
    camera.lookAt(0, 0.44, 0);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.prepend(renderer.domElement);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x9098b8, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(1.5, 3, 2.5);
    scene.add(sun);
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.42, 48),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18 })
    );
    shadow.rotation.x = -Math.PI / 2;
    scene.add(shadow);
    world.current = { scene, current: null, mixer: null, actions: {}, yaw: -0.4 };

    let dragging = false, lastX = 0, idleAt = 0;
    const canvas = renderer.domElement;
    const down = (e: PointerEvent) => { dragging = true; lastX = e.clientX; canvas.setPointerCapture(e.pointerId); };
    const move = (e: PointerEvent) => {
      if (!dragging || !world.current) return;
      world.current.yaw += (e.clientX - lastX) * 0.012;
      lastX = e.clientX;
    };
    const up = () => { dragging = false; idleAt = performance.now(); };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);

    const resize = () => {
      const w = mount.clientWidth, h = mount.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const clock = new THREE.Clock();
    renderer.setAnimationLoop((t) => {
      const w = world.current!;
      const dt = clock.getDelta();
      if (!dragging && !reduce && t - idleAt > 1500) w.yaw += 0.004;
      if (w.current) w.current.root.rotation.y = w.yaw;
      w.mixer?.update(dt);
      renderer.render(scene, camera);
    });

    return () => {
      ro.disconnect();
      renderer.setAnimationLoop(null);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      world.current?.current?.dispose();
      shadow.geometry.dispose();
      (shadow.material as THREE.Material).dispose();
      renderer.dispose();
      canvas.remove();
      world.current = null;
    };
  }, []);

  // 설정이 바뀌면 캐릭터를 다시 조립해 바꿔 끼운다(늦게 끝난 이전 조립은 버린다).
  useEffect(() => {
    let cancelled = false;
    buildCharacter(config, photoUrl)
      .then((built) => {
        const w = world.current;
        if (cancelled || !w) return built.dispose();
        if (w.current) {
          w.scene.remove(w.current.root);
          w.current.dispose();
        }
        w.current = built;
        w.scene.add(built.root);
        w.mixer = new THREE.AnimationMixer(built.root);
        w.actions = Object.fromEntries(built.animations.map((c) => [c.name, w.mixer!.clipAction(c)]));
        play(anim, true);
        setLoading(false);
        setFailed(false);
        onHairLock?.(built.hairColorLocked);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(config), photoUrl]);

  function play(name: string, instant = false) {
    const w = world.current;
    if (!w?.mixer) return;
    const a = w.actions[name] ?? w.actions.idle;
    if (!a) return;
    for (const other of Object.values(w.actions)) if (other !== a) other.fadeOut(instant ? 0 : 0.2);
    a.reset();
    if (ONCE.has(name)) {
      a.setLoop(THREE.LoopOnce, 1);
      const mixer = w.mixer;
      const back = (e: { action: THREE.AnimationAction }) => {
        if (e.action !== a) return;
        mixer.removeEventListener("finished", back as never);
        setAnim("idle");
        play("idle");
      };
      mixer.addEventListener("finished", back as never);
    } else {
      a.setLoop(THREE.LoopRepeat, Infinity);
    }
    a.fadeIn(instant ? 0 : 0.2).play();
  }

  return (
    <div className="character-stage-wrap">
      <div className="character-stage" ref={mountRef} aria-label="3D 캐릭터 (드래그해서 돌리기)">
        {loading && !failed && <span className="character-stage-msg">캐릭터 불러오는 중…</span>}
        {failed && <span className="character-stage-msg">캐릭터를 불러오지 못했어요.</span>}
      </div>
      {showActions && (
        <div className="character-actions">
          {ANIMS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={anim === key ? "active" : "ghost"}
              onClick={() => {
                setAnim(key);
                play(key);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
