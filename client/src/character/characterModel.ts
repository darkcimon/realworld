// 3D 캐릭터 조립: 몸(옷) 모델 + 다른 모델의 머리(헤어) + 피부/헤어 다시 칠하기 + 사진 얼굴 스티커.
// 모델은 Kenney "Mini Characters"(CC0). 12명 모두 같은 뼈대라 머리 메시만 바꿔 끼우면 된다.
// three.js가 크므로 이 파일은 CharacterStage(React.lazy)를 통해서만 불러온다.
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { SKIN_COLORS, HAIR_COLORS, type CharacterConfig } from "./options";

const DIR = "/models/characters/";
const loader = new GLTFLoader().setPath(DIR);
const cache = new Map<string, Promise<GLTF>>();
function loadModel(name: string): Promise<GLTF> {
  if (!cache.has(name)) cache.set(name, loader.loadAsync(`character-${name}.glb`));
  return cache.get(name)!;
}

// ── 색 팔레트 다시 칠하기 ─────────────────────────────────────
// 모델은 512px 팔레트 한 장(32×128px 칸 16×4개)으로 칠해져 있다. 피부/머리카락이 쓰는 칸만 다른 색으로 칠한다.
type Cell = string; // "cx,cy"
let baseAtlas: ImageData | null = null;

function cellOf(u: number, v: number): Cell {
  return `${Math.min(15, Math.floor(u * 16))},${Math.min(3, Math.floor(v * 4))}`;
}

/** pick 조건을 만족하는 정점들이 가장 많이 쓰는 칸 */
function sampleCell(geo: THREE.BufferGeometry, pick: (x: number, y: number, z: number) => boolean): Cell | null {
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  const counts = new Map<Cell, number>();
  for (let i = 0; i < pos.count; i++) {
    if (!pick(pos.getX(i), pos.getY(i), pos.getZ(i))) continue;
    const c = cellOf(uv.getX(i), uv.getY(i));
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let best: Cell | null = null, n = 0;
  for (const [c, k] of counts) if (k > n) { best = c; n = k; }
  return best;
}

// 피부 칸은 귀에서 찾는다 — 12개 머리 모두 귀가 피부색이고, 얼굴 앞쪽은 눈·입·앞머리가 섞여 있다.
const earCell = (geo: THREE.BufferGeometry) =>
  sampleCell(geo, (x, y, z) => Math.abs(x) > 0.2 && y > 0.38 && y < 0.52 && Math.abs(z) < 0.1);

function cellHex(key: Cell | null): string {
  if (!key || !baseAtlas) return "#f3c39b";
  const [cx, cy] = key.split(",").map(Number);
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = cy * 128; y < cy * 128 + 128; y += 4)
    for (let x = cx * 32; x < cx * 32 + 32; x += 4) {
      const i = (y * 512 + x) * 4;
      r += baseAtlas.data[i]; g += baseAtlas.data[i + 1]; b += baseAtlas.data[i + 2]; n++;
    }
  return "#" + [r, g, b].map((v) => Math.round(v / n).toString(16).padStart(2, "0")).join("");
}

function recolored(paint: Record<Cell, string>): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d")!;
  g.putImageData(baseAtlas!, 0, 0);
  for (const [key, hex] of Object.entries(paint)) {
    const [cx, cy] = key.split(",").map(Number);
    const img = g.getImageData(cx * 32, cy * 128, 32, 128);
    const d = img.data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
    const mean = sum / (d.length / 4) || 1;
    const t = new THREE.Color(hex);
    for (let i = 0; i < d.length; i += 4) {
      const k = (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11) / mean; // 칸 안의 명암은 유지
      d[i] = Math.min(255, t.r * 255 * k);
      d[i + 1] = Math.min(255, t.g * 255 * k);
      d[i + 2] = Math.min(255, t.b * 255 * k);
    }
    g.putImageData(img, cx * 32, cy * 128);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

function captureAtlas(map: THREE.Texture) {
  if (baseAtlas) return;
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d")!;
  g.drawImage(map.image as CanvasImageSource, 0, 0, 512, 512);
  baseAtlas = g.getImageData(0, 0, 512, 512);
}

// ── 사진 → 동그란 스티커 ─────────────────────────────────────
const stickerCache = new Map<string, Promise<THREE.CanvasTexture>>();
function stickerTexture(photoUrl: string): Promise<THREE.CanvasTexture> {
  if (!stickerCache.has(photoUrl)) {
    stickerCache.set(
      photoUrl,
      new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          const size = 512, c = document.createElement("canvas");
          c.width = c.height = size;
          const g = c.getContext("2d")!;
          const s = Math.min(img.width, img.height);
          g.save();
          g.beginPath(); g.arc(size / 2, size / 2, size / 2 - 16, 0, Math.PI * 2); g.clip();
          g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
          g.restore();
          g.lineWidth = 22; g.strokeStyle = "#ffffff";
          g.beginPath(); g.arc(size / 2, size / 2, size / 2 - 16, 0, Math.PI * 2); g.stroke();
          const t = new THREE.CanvasTexture(c);
          t.colorSpace = THREE.SRGBColorSpace;
          t.anisotropy = 4;
          resolve(t);
        };
        img.onerror = reject;
        img.src = photoUrl;
      })
    );
  }
  return stickerCache.get(photoUrl)!;
}

function findMesh(root: THREE.Object3D, name: string): THREE.SkinnedMesh {
  let found: THREE.SkinnedMesh | null = null;
  root.traverse((o) => {
    if (!found && (o as THREE.SkinnedMesh).isMesh && (o.name === name || o.parent?.name === name)) found = o as THREE.SkinnedMesh;
  });
  if (!found) throw new Error(`mesh ${name} not found`);
  return found;
}

/** 얼굴 앞면(코 높이)의 z — 사진 스티커를 그 바로 앞에 붙인다(앞머리가 튀어나온 머리도 있다). */
function frontZ(geo: THREE.BufferGeometry): number {
  const p = geo.attributes.position;
  let z = 0.15;
  for (let i = 0; i < p.count; i++) if (Math.abs(p.getX(i)) < 0.1 && p.getY(i) > 0.42 && p.getY(i) < 0.56) z = Math.max(z, p.getZ(i));
  return z;
}

export interface BuiltCharacter {
  root: THREE.Object3D;
  animations: THREE.AnimationClip[];
  hairColorLocked: boolean; // 이 헤어는 지금 얼굴 모드에서 색을 바꿀 수 없다(눈과 같은 색 칸)
  dispose: () => void;
}

/**
 * 설정대로 캐릭터를 조립한다. photoUrl이 있고 face === "photo"면 프로필 사진을 얼굴 스티커로 붙인다.
 * 반환된 root의 크기: 키 165cm ≈ 0.78 단위(키에 비례해 확대/축소).
 */
export async function buildCharacter(config: CharacterConfig, photoUrl: string | null): Promise<BuiltCharacter> {
  const [bodyGltf, headGltf, sticker] = await Promise.all([
    loadModel(`${config.gender}-${config.body}`),
    loadModel(config.head),
    config.face === "photo" && photoUrl ? stickerTexture(photoUrl).catch(() => null) : Promise.resolve(null),
  ]);
  const root = cloneSkinned(bodyGltf.scene);
  const bodyHead = findMesh(root, "head-mesh");
  const bodyMesh = findMesh(root, "body-mesh");
  captureAtlas((bodyMesh.material as THREE.MeshStandardMaterial).map!);

  const bodySkin = earCell(bodyHead.geometry); // 이 몸의 원래 피부(손) 칸
  bodyHead.geometry = findMesh(headGltf.scene, "head-mesh").geometry; // 뼈대가 같아 머리만 바꿔 끼운다
  const hg = bodyHead.geometry;
  const headSkin = earCell(hg);
  if (!hg.boundingBox) hg.computeBoundingBox();
  const topY = hg.boundingBox!.max.y;
  const hairCell = sampleCell(hg, (x, y) => y > topY - 0.05 && Math.abs(x) < 0.15); // 정수리(민머리·모자면 피부/모자)

  const chosenSkin = SKIN_COLORS[config.skin];
  const skinHex = chosenSkin ?? cellHex(headSkin);
  const headPaint: Record<Cell, string> = {}, bodyPaint: Record<Cell, string> = {};
  if (chosenSkin && headSkin) headPaint[headSkin] = chosenSkin;
  // 검은 머리 칸("1,3")은 눈·입과 같은 칸이라, 캐릭터 얼굴이 보일 때는 칠하지 않는다(눈 색까지 바뀐다).
  const showsModelFace = !sticker;
  const hairShared = hairCell === "1,3" && showsModelFace;
  const chosenHair = HAIR_COLORS[config.hair];
  if (chosenHair && hairCell && hairCell !== headSkin && !hairShared) headPaint[hairCell] = chosenHair;
  // 손은 얼굴 피부색에 맞춘다(다른 캐릭터의 머리를 쓰면 원래 손 색과 다를 수 있다).
  if (bodySkin && (chosenSkin || bodySkin !== headSkin)) bodyPaint[bodySkin] = skinHex;

  const textures: THREE.Texture[] = [];
  const headMat = (bodyHead.material as THREE.MeshStandardMaterial).clone();
  headMat.map = recolored(headPaint);
  const bodyMat = (bodyMesh.material as THREE.MeshStandardMaterial).clone();
  bodyMat.map = recolored(bodyPaint);
  textures.push(headMat.map, bodyMat.map);
  bodyHead.material = headMat;
  bodyMesh.material = bodyMat;

  // 사진 스티커는 머리 뼈에 붙여 애니메이션을 따라 움직이게 한다.
  const extra: THREE.Mesh[] = [];
  if (sticker) {
    const headBone = root.getObjectByName("head")!;
    root.updateMatrixWorld(true);
    const toBone = headBone.matrixWorld.clone().invert();
    const r = 0.165 * config.faceSize;
    const mesh = new THREE.Mesh(
      new THREE.CircleGeometry(r, 48),
      new THREE.MeshStandardMaterial({ map: sticker, transparent: true, alphaTest: 0.5, roughness: 0.85 })
    );
    mesh.position.copy(new THREE.Vector3(0, 0.49, frontZ(hg) + 0.006).applyMatrix4(toBone));
    headBone.add(mesh);
    extra.push(mesh);
  }

  root.scale.setScalar(config.height / 165);
  return {
    root,
    animations: bodyGltf.animations,
    hairColorLocked: hairShared,
    dispose: () => {
      textures.forEach((t) => t.dispose());
      headMat.dispose();
      bodyMat.dispose();
      extra.forEach((m) => {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose(); // 스티커 텍스처는 캐시에서 계속 쓴다
      });
    },
  };
}
