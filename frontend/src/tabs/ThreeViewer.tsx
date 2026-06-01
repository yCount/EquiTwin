import React, { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import "./ThreeViewer.scss";

// ── Public types ─────────────────────────────────────────────────────────────

export interface SensorDef {
  id: string;
  kind: "occupancy" | "room";
  /** World-space position [x, y, z] in the loaded model (metres, Y-up). */
  position: [number, number, number];
  /** Floor identifier — must match strings used in hiddenFloors. */
  floor: string;
  label: string;
}

/**
 * Default sensor positions — edit these after loading your model so the
 * spheres land at the correct spots.  Positions are in metres, Y-up.
 */
export const DEFAULT_SENSORS: SensorDef[] = [
  { id: "occ-l3-a", kind: "occupancy", position: [-8,  3.5, -5], floor: "level3", label: "Occupancy L3 West" },
  { id: "occ-l3-b", kind: "occupancy", position: [ 8,  3.5,  5], floor: "level3", label: "Occupancy L3 East" },
  { id: "occ-l4-a", kind: "occupancy", position: [-8,  7.2, -5], floor: "level4", label: "Occupancy L4 West" },
  { id: "occ-l4-b", kind: "occupancy", position: [ 8,  7.2,  5], floor: "level4", label: "Occupancy L4 East" },
  { id: "room-l3",  kind: "room",      position: [ 0,  3.5,  0], floor: "level3", label: "Room Sensor L3"    },
  { id: "room-l4",  kind: "room",      position: [ 0,  7.2,  0], floor: "level4", label: "Room Sensor L4"    },
];

const SENSOR_COLOR: Record<SensorDef["kind"], number> = {
  occupancy: 0x28f6ff,
  room:      0xffb14a,
};

export interface ThreeViewerProps {
  /**
   * URLs (relative to public/) of the building models to load.
   * Supported formats: .ifc  .glb  .gltf  .obj — mix formats freely.
   * Leave empty/undefined to show only sensor markers over a reference grid.
   */
  modelUrls?: string[];
  sensors?: SensorDef[];
  hiddenFloors?: Set<string>;
  onSensorClick?: (sensor: SensorDef, screenPos: { x: number; y: number }) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

const ThreeViewer: React.FC<ThreeViewerProps> = ({
  modelUrls = [],
  sensors = DEFAULT_SENSORS,
  hiddenFloors = new Set<string>(),
  onSensorClick,
}) => {
  const mountRef        = useRef<HTMLDivElement>(null);
  const canvasRef       = useRef<HTMLCanvasElement>(null);
  const rendRef         = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef       = useRef<THREE.PerspectiveCamera | null>(null);
  const sceneRef        = useRef<THREE.Scene | null>(null);
  const ctrlRef         = useRef<OrbitControls | null>(null);
  const clockRef        = useRef(new THREE.Clock());
  const frameRef        = useRef(0);
  const sensorGroupRef  = useRef<THREE.Group | null>(null);
  const modelsGroupRef  = useRef<THREE.Group | null>(null);

  const [progress,      setProgress]      = useState(0);
  const [loading,       setLoading]       = useState(false);
  const [loadError,     setLoadError]     = useState<string | null>(null);
  const [loadingLabel,  setLoadingLabel]  = useState("Loading models…");
  // null = no RVT overlay; "setup" = APS not configured; "converting" = job in progress
  const [rvtOverlay,    setRvtOverlay]    = useState<null | "setup" | "converting">(null);

  // ── Scene init (runs once) ────────────────────────────────────────────────
  useEffect(() => {
    const mount  = mountRef.current;
    const canvas = canvasRef.current;
    if (!mount || !canvas) return;

    // Measure from the parent (viewer-wrapper) — it has the reliable CSS size.
    // Measuring the canvas itself fails because its height:100% chain can collapse to 0.
    const getSize = () => {
      const el = mount.parentElement ?? mount;
      return { W: el.clientWidth || 800, H: el.clientHeight || 600 };
    };

    const { W, H } = getSize();

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1d21);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 5000);
    camera.position.set(20, 15, 20);
    cameraRef.current = camera;

    // Renderer uses the pre-declared <canvas> — no DOM appendChild needed.
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // updateStyle=true so Three.js sets canvas.style.width/height to exact px values,
    // overriding any CSS that might collapse the canvas to 0.
    renderer.setSize(W, H, true);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    rendRef.current = renderer;

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const sun = new THREE.DirectionalLight(0xfff5e0, 1.2);
    sun.position.set(60, 120, 60);
    scene.add(sun);
    scene.add(new THREE.HemisphereLight(0x8899ff, 0x444422, 0.5));

    // Reference grid — brighter so it's visible even before a model loads
    const grid = new THREE.GridHelper(200, 50, 0x444466, 0x333355);
    grid.name = "__grid";
    scene.add(grid);

    const mg = new THREE.Group();
    mg.name = "models";
    scene.add(mg);
    modelsGroupRef.current = mg;

    const sg = new THREE.Group();
    sg.name = "sensors";
    scene.add(sg);
    sensorGroupRef.current = sg;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 0.5;
    controls.maxDistance = 2000;
    ctrlRef.current = controls;

    // Watch the PARENT element — it has the reliable dimensions from the layout engine.
    // When it resizes, update the renderer with explicit pixel sizes (updateStyle=true).
    const ro = new ResizeObserver(() => {
      const { W, H } = getSize();
      if (W < 1 || H < 1) return;
      camera.aspect = W / H;
      camera.updateProjectionMatrix();
      renderer.setSize(W, H, true);
    });
    ro.observe(mount.parentElement ?? mount);

    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
      const t = clockRef.current.getElapsedTime();
      sg.traverse((obj) => {
        if (obj.userData.isSensorCore) {
          const mat = (obj as THREE.Mesh).material as THREE.MeshStandardMaterial;
          mat.emissiveIntensity = 0.35 + 0.3 * Math.sin(t * 2.2 + (obj.userData.phase as number));
        }
        if (obj.userData.isHalo) obj.rotation.z = t * 0.7;
      });
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(frameRef.current);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
    };
  }, []);

  // ── Model loading (all URLs loaded in parallel) ───────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    const mg    = modelsGroupRef.current;
    if (!scene || !mg) return;

    // Clear previously loaded models
    mg.clear();

    if (!modelUrls.length) return;

    setLoading(true);
    setLoadError(null);
    setProgress(0);

    let cancelled  = false;
    let doneCount  = 0;
    const errors: string[] = [];

    const finishOne = () => {
      if (cancelled) return;
      doneCount++;
      setProgress(Math.round((doneCount / modelUrls.length) * 100));

      if (doneCount < modelUrls.length) return;

      // All files settled — fit camera to combined bounding box
      if (mg.children.length) {
        const box    = new THREE.Box3().setFromObject(mg);
        const center = box.getCenter(new THREE.Vector3());
        const size   = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 20;

        mg.position.sub(center);

        const cam = cameraRef.current!;
        cam.near = maxDim / 1000;
        cam.far  = maxDim * 100;
        cam.position.set(maxDim * 1.2, maxDim * 0.7, maxDim * 1.2);
        cam.updateProjectionMatrix();
        ctrlRef.current!.target.set(0, 0, 0);
        ctrlRef.current!.update();

        const grid = scene.getObjectByName("__grid");
        if (grid) scene.remove(grid);
      }

      setLoading(false);
      if (errors.length) setLoadError(errors.join("\n"));
    };

    const onOneLoaded = (obj: THREE.Object3D) => {
      if (!cancelled) mg.add(obj);
      finishOne();
    };

    const onOneError = (url: string) => (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${url.split("/").pop()}: ${msg}`);
      finishOne();
    };

    const loadIfc = async (ifcUrl: string, originalUrl: string) => {
      try {
        const { IFCLoader } = await import("web-ifc-three");
        const loader = new IFCLoader();
        await loader.ifcManager.setWasmPath("/wasm/");
        loader.load(ifcUrl, onOneLoaded, undefined, onOneError(originalUrl));
      } catch {
        onOneError(originalUrl)(new Error("IFC loader not found — run: npm install web-ifc-three web-ifc"));
      }
    };

    const loadUrl = async (url: string) => {
      const name = url.split("/").pop() ?? url;
      const ext  = name.split(".").pop()?.toLowerCase();

      if (ext === "glb" || ext === "gltf") {
        setLoadingLabel(`Loading ${name}…`);
        new GLTFLoader().load(url, (gltf) => onOneLoaded(gltf.scene), undefined, onOneError(url));

      } else if (ext === "obj") {
        setLoadingLabel(`Loading ${name}…`);
        new OBJLoader().load(url, onOneLoaded, undefined, onOneError(url));

      } else if (ext === "ifc") {
        setLoadingLabel(`Loading ${name}…`);
        await loadIfc(url, url);

      } else if (ext === "rvt") {
        // ── Step 1: check whether the backend has APS credentials ──────────
        let capable = false;
        try {
          const capRes  = await fetch("http://localhost:8000/api/models/rvt-capable");
          const capData = await capRes.json() as { capable: boolean; reason?: string };
          capable = capData.capable;
          if (!capable) {
            // Show setup instructions and count this file as "done" (skipped)
            setRvtOverlay("setup");
            finishOne();
            return;
          }
        } catch {
          // Backend unreachable
          errors.push(
            `${name}: cannot reach the backend at localhost:8000. ` +
            `Start it with: uvicorn app:app --reload`,
          );
          finishOne();
          return;
        }

        // ── Step 2: start / resume APS conversion ──────────────────────────
        try {
          const fileUrl  = `${window.location.origin}${url}`;
          const startRes = await fetch(
            `http://localhost:8000/api/models/rvt-convert?file_url=${encodeURIComponent(fileUrl)}`,
            { method: "POST" },
          );

          if (!startRes.ok) {
            const detail = await startRes.json()
              .then((j: { detail?: string }) => j.detail ?? startRes.statusText)
              .catch(() => startRes.statusText);
            // 404 means file not found on the dev server
            const hint = startRes.status === 404
              ? ` — make sure ${name} is in frontend/public/models/ and npm start is running`
              : "";
            throw new Error(`${detail}${hint}`);
          }

          const startData = await startRes.json() as { status: string; path?: string; urn?: string; filename?: string };

          if (startData.status === "cached" || startData.status === "complete") {
            setRvtOverlay(null);
            setLoadingLabel(`Loading converted IFC for ${name}…`);
            await loadIfc(startData.path!, url);
            return;
          }

          // ── Step 3: poll until translation finishes ─────────────────────
          setRvtOverlay("converting");
          setLoadingLabel(`Converting ${name} via APS…`);
          const { urn, filename: rvtFilename } = startData;

          while (!cancelled) {
            await new Promise<void>((res) => setTimeout(res, 10_000));
            if (cancelled) break;

            const pollRes  = await fetch(
              `http://localhost:8000/api/models/rvt-status/${urn}` +
              `?filename=${encodeURIComponent(rvtFilename ?? name)}`,
            );
            const pollData = await pollRes.json() as { status: string; path?: string; progress?: string; error?: string };

            if (pollData.status === "complete") {
              setRvtOverlay(null);
              setLoadingLabel(`Loading converted IFC for ${name}…`);
              await loadIfc(pollData.path!, url);
              break;
            } else if (pollData.status === "failed") {
              throw new Error(pollData.error ?? "APS conversion failed");
            } else {
              setLoadingLabel(`Converting ${name} via APS… ${pollData.progress ?? ""}`);
            }
          }
        } catch (err) {
          setRvtOverlay(null);
          onOneError(url)(err);
        }

      } else {
        onOneError(url)(new Error(`Unsupported format ".${ext}". Supported: .rvt .ifc .glb .gltf .obj`));
      }
    };

    modelUrls.forEach(loadUrl);

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelUrls.join(",")]);

  // ── Sensor markers ────────────────────────────────────────────────────────
  useEffect(() => {
    const sg = sensorGroupRef.current;
    if (!sg) return;

    sg.clear();

    sensors
      .filter((s) => !hiddenFloors.has(s.floor))
      .forEach((sensor, i) => {
        const col  = SENSOR_COLOR[sensor.kind];
        const root = new THREE.Group();
        root.position.set(...sensor.position);
        root.userData = { sensor };

        // Core glowing sphere
        const coreMat = new THREE.MeshStandardMaterial({
          color:             col,
          emissive:          col,
          emissiveIntensity: 0.5,
          roughness:         0.2,
          metalness:         0.1,
          transparent:       true,
          opacity:           0.92,
        });
        const core = new THREE.Mesh(new THREE.SphereGeometry(0.35, 24, 24), coreMat);
        core.userData = { isSensorCore: true, phase: i * 1.1, sensor };
        root.add(core);

        // Animated halo ring
        const halo = new THREE.Mesh(
          new THREE.TorusGeometry(0.62, 0.055, 8, 40),
          new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.45, side: THREE.DoubleSide }),
        );
        halo.rotation.x = Math.PI / 2;
        halo.userData = { isHalo: true };
        root.add(halo);

        // Local point light for glow
        root.add(new THREE.PointLight(col, 0.9, 5));

        // Vertical stem to ground level
        const pts = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -sensor.position[1], 0)];
        root.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.22 }),
        ));

        sg.add(root);
      });
  }, [sensors, hiddenFloors]);

  // ── Click → sensor selection ───────────────────────────────────────────────
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const canvas = canvasRef.current;
      const camera = cameraRef.current;
      const sg     = sensorGroupRef.current;
      if (!canvas || !camera || !sg || !sg.children.length) return;

      const rect  = canvas.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width)  *  2 - 1,
        ((e.clientY - rect.top)  / rect.height) * -2 + 1,
      );

      const rc = new THREE.Raycaster();
      rc.setFromCamera(mouse, camera);
      const hits = rc.intersectObjects(sg.children, true);
      if (!hits.length) return;

      let obj: THREE.Object3D | null = hits[0].object;
      while (obj && !obj.userData.sensor) obj = obj.parent;
      if (obj?.userData.sensor) {
        onSensorClick?.(obj.userData.sensor as SensorDef, { x: e.clientX, y: e.clientY });
      }
    },
    [onSensorClick],
  );

  return (
    <div className="three-viewer" ref={mountRef} onClick={handleClick}>
      {/* Canvas declared in JSX so CSS controls its size before Three.js init */}
      <canvas ref={canvasRef} className="three-viewer__canvas" />

      {loading && (
        <div className="three-viewer__overlay">
          <div className="three-viewer__bar-track">
            <div className="three-viewer__bar-fill" style={{ width: `${progress}%` }} />
          </div>
          <span className="three-viewer__overlay-text">{loadingLabel}</span>
        </div>
      )}
      {loadError && (
        <div className="three-viewer__overlay three-viewer__overlay--error">
          <span>⚠ {loadError}</span>
        </div>
      )}
      {!modelUrls.length && !loading && (
        <div className="three-viewer__overlay three-viewer__overlay--hint">
          Place your exported <code>.ifc</code>, <code>.glb</code>, or <code>.obj</code> files in{" "}
          <code>public/models/</code> and list them in <code>modelUrls</code>
        </div>
      )}
    </div>
  );
};

export default ThreeViewer;
