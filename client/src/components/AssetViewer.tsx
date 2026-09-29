import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

// 자산(자동차/아파트/명품) 3D 전시장 — 드래그로 돌려보고 핀치/휠로 확대, 가만히 두면 턴테이블처럼 천천히 돈다.
// three.js가 수백 KB라 이 파일은 React.lazy로만 불러와서 3D 창을 처음 열 때만 내려받게 한다.
// 모델 출처와 라이선스는 public/models/*/ 안의 LICENSE/CREDITS 파일 참고.
// 실사 모델(Khronos glTF 샘플)은 gltf-transform으로 압축(meshopt + WebP)해 두었으므로 MeshoptDecoder가 필요하고,
// 금속/유리/가죽 재질이 제대로 보이도록 환경맵(RoomEnvironment) 조명을 깐다.
// 모델을 못 불러오면 코드로 만든 단순한 모양으로 대신 보여준다.
export type AssetCategory = "car" | "apartment" | "luxury";

type ModelSpec = { file: string; icon?: string; credit?: string };

const KHRONOS = "Khronos glTF Sample Assets";
const MODELS: Record<AssetCategory, { dir: string; icon: string; byName: Record<string, ModelSpec>; fallback: ModelSpec }> = {
  // Kenney Car Kit (CC0) + 슈퍼카만 실사 모델
  car: {
    dir: "cars",
    icon: "🚗",
    byName: {
      경차: { file: "sedan.glb" }, // 키트에서 가장 짧고 각진 차
      "준중형 세단": { file: "hatchback-sports.glb" },
      스포츠카: { file: "sedan-sports.glb" },
      슈퍼카: { file: "car-concept.glb", credit: `"Car Concept" © Darmstadt Graphics Group, Eric Chadwick (${KHRONOS}, CC BY 4.0)` },
    },
    fallback: { file: "sedan.glb" },
  },
  // Kenney City Kit Commercial (CC0)
  apartment: {
    dir: "buildings",
    icon: "🏠",
    byName: {
      원룸: { file: "building-c.glb" },
      "84㎡ 아파트": { file: "building-j.glb" },
      펜트하우스: { file: "building-skyscraper-a.glb" },
    },
    fallback: { file: "building-j.glb" },
  },
  // 명품: 브랜드 로고가 없는 실사 모델(모두 Khronos glTF 샘플, CC BY 4.0)
  luxury: {
    dir: "luxury",
    icon: "💎",
    byName: {
      "명품 선글라스": {
        file: "sunglasses.glb",
        icon: "🕶️",
        credit: `"Sunglasses Khronos" © Darmstadt Graphics Group, Eric Chadwick (${KHRONOS}, CC BY 4.0)`,
      },
      "명품 운동화": { file: "sneaker.glb", icon: "👟", credit: `"Materials Variants Shoe" © Shopify (${KHRONOS}, CC BY 4.0)` },
      "명품 스탠드 조명": {
        file: "lamp.glb",
        icon: "💡",
        credit: `"Stained Glass Lamp" © Wayfair, Eric Chadwick (${KHRONOS}, CC BY 4.0)`,
      },
      "명품 시계": {
        file: "watch.glb",
        icon: "⌚",
        credit: `"Chronograph Watch" © Darmstadt Graphics Group, based on graphiccompressor (${KHRONOS}, CC BY 4.0)`,
      },
      "명품 가죽 소파": {
        file: "sofa.glb",
        icon: "🛋️",
        credit: `"Sheen Wood Leather Sofa" © Darmstadt Graphics Group, Eric Chadwick / Fran Calvente (${KHRONOS}, CC BY 4.0)`,
      },
    },
    fallback: { file: "watch.glb", icon: "⌚" },
  },
};

// 모델마다 실제 크기(시계 4cm ~ 건물 수십 m)가 달라서, 가장 긴 변이 이 길이가 되도록 맞춘 뒤 전시한다.
const DISPLAY_SIZE = 2;

function fallbackModel(category: AssetCategory): THREE.Group {
  if (category !== "car") {
    const g = new THREE.Group();
    const color = category === "apartment" ? 0xdfe3ea : 0x6b4a2b;
    const box = new THREE.Mesh(
      category === "apartment" ? new THREE.BoxGeometry(1, 2, 1) : new THREE.BoxGeometry(1, 0.7, 0.35),
      new THREE.MeshStandardMaterial({ color, roughness: 0.6 })
    );
    box.position.y = category === "apartment" ? 1 : 0.35;
    g.add(box);
    return g;
  }
  const car = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: 0xd9433b, roughness: 0.4 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x9fc6e8, roughness: 0.1 });
  const tire = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.9 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(2, 0.5, 1), paint);
  body.position.y = 0.45;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.4, 0.9), glass);
  cabin.position.set(-0.1, 0.9, 0);
  car.add(body, cabin);
  for (const [x, z] of [[0.65, 0.5], [0.65, -0.5], [-0.65, 0.5], [-0.65, -0.5]]) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.18, 20), tire);
    wheel.rotation.x = Math.PI / 2;
    wheel.position.set(x, 0.22, z);
    car.add(wheel);
  }
  return car;
}

export default function AssetViewer({
  category,
  name,
  onClose,
}: {
  category: AssetCategory;
  name: string;
  onClose: () => void;
}) {
  const config = MODELS[category];
  const spec = config.byName[name] ?? config.fallback;
  const mountRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const mount = mountRef.current!;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x15171c);

    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    mount.appendChild(renderer.domElement);

    // 환경맵: 실내 스튜디오 반사광. 금속·유리·클리어코트 재질은 이게 없으면 까맣고 밋밋하게 보인다.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envMap;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 0.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(3, 5, 4);
    scene.add(sun);

    // 원형 전시대
    const stage = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 0.04, 64),
      new THREE.MeshStandardMaterial({ color: 0x2a2e38, roughness: 0.6 })
    );
    scene.add(stage);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 1.5;
    controls.maxPolarAngle = Math.PI / 2 - 0.05; // 바닥 아래로는 못 내려가게
    // 만지는 동안은 자동 회전을 멈추고, 손을 떼면 다시 돈다.
    controls.addEventListener("start", () => (controls.autoRotate = false));
    controls.addEventListener("end", () => (controls.autoRotate = true));

    // 모델 크기를 DISPLAY_SIZE로 맞춘 뒤 전시대/카메라 거리를 잡는다(시계든 건물이든 화면에 꽉 차게).
    function place(obj: THREE.Object3D) {
      const raw = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3());
      const longest = Math.max(raw.x, raw.y, raw.z);
      if (longest > 0) obj.scale.multiplyScalar(DISPLAY_SIZE / longest);
      const box = new THREE.Box3().setFromObject(obj);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      obj.position.x -= center.x;
      obj.position.z -= center.z;
      obj.position.y -= box.min.y - 0.02;
      scene.add(obj);
      const radius = Math.max(size.x, size.z) * 0.7;
      stage.scale.set(radius, 1, radius);
      const dist = Math.max(size.x, size.y, size.z) * 2.2;
      camera.position.set(dist * 0.8, dist * 0.45, dist);
      controls.target.set(0, size.y * 0.4, 0);
      controls.minDistance = dist * 0.5;
      controls.maxDistance = dist * 2;
      controls.update();
      setLoading(false);
    }

    let disposed = false;
    new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).load(
      `/models/${config.dir}/${spec.file}`,
      (gltf) => {
        if (disposed) return;
        place(gltf.scene);
      },
      undefined,
      () => !disposed && place(fallbackModel(category))
    );

    function resize() {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    renderer.setAnimationLoop(() => {
      controls.update();
      renderer.render(scene, camera);
    });

    return () => {
      disposed = true;
      ro.disconnect();
      renderer.setAnimationLoop(null);
      controls.dispose();
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          for (const m of [o.material].flat()) m.dispose();
        }
      });
      envMap.dispose();
      pmrem.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, [category, name]);

  return (
    // 프로필 창 위에 겹쳐 뜰 때 바깥 클릭이 아래 프로필 창까지 닫지 않도록 전파를 막는다.
    <div
      className="modal-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="modal asset-viewer-modal" onClick={(e) => e.stopPropagation()}>
        <h2>
          {spec.icon ?? config.icon} {name}
        </h2>
        <div className="asset-viewer-stage" ref={mountRef}>
          {loading && <p className="asset-viewer-loading muted">불러오는 중...</p>}
        </div>
        <p className="muted asset-viewer-hint">드래그해서 돌려보고, 두 손가락(휠)으로 확대할 수 있어요.</p>
        {spec.credit && <p className="muted asset-viewer-hint">모델: {spec.credit}</p>}
        <button className="modal-close" onClick={onClose}>
          닫기
        </button>
      </div>
    </div>
  );
}
