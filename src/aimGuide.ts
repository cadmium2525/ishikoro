import * as THREE from 'three';
import { AIM_RANGE } from './input';

const DOTS = 14;

/** 足元に出る方向ガイド。点の並びで方向・強さ・回転を示す。 */
export class AimGuide {
  readonly group = new THREE.Group();
  private readonly dots: THREE.InstancedMesh;
  private readonly fan: THREE.Mesh;
  private readonly dotMat = new THREE.MeshBasicMaterial({ color: 0xfff6e0, transparent: true, opacity: 0.9, depthWrite: false });
  private readonly normal = new THREE.Color(0xfff6e0);
  private readonly danger = new THREE.Color(0xe0553a);
  private readonly m = new THREE.Matrix4();

  constructor() {
    const dotGeo = new THREE.CircleGeometry(0.045, 10);
    dotGeo.rotateX(-Math.PI / 2);
    this.dots = new THREE.InstancedMesh(dotGeo, this.dotMat, DOTS);
    this.dots.renderOrder = 2;
    this.group.add(this.dots);

    // 振れ幅を示す薄い扇形（XY平面の -90° が床に倒すと +Z になる）
    const fanGeo = new THREE.CircleGeometry(1.4, 24, -Math.PI / 2 - AIM_RANGE, AIM_RANGE * 2);
    fanGeo.rotateX(-Math.PI / 2);
    this.fan = new THREE.Mesh(fanGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, depthWrite: false }));
    this.fan.renderOrder = 1;
    this.group.add(this.fan);
    this.group.position.y = 0.01;
  }

  /**
   * @param center 扇の中心方向（+Z を 0 とするヨー角）
   * @param aim 実際の方向
   * @param power 0..1+（0 の時は狙い中の表示）
   */
  update(origin: THREE.Vector3, center: number, aim: number, power: number, spin: number, charging: boolean) {
    this.group.position.x = origin.x;
    this.group.position.z = origin.z;
    // 高さ（歩道の段差）は呼び出し側で合わせる
    this.fan.rotation.y = center;

    const length = charging ? 0.5 + Math.min(power, 1) * 3.2 : 1.3;
    const over = power > 1;
    this.dotMat.color.copy(over ? this.danger : this.normal);

    let x = 0;
    let z = 0;
    let heading = aim;
    const step = length / DOTS;
    for (let i = 0; i < DOTS; i++) {
      // 回転は先へ行くほど曲がる（右回転＝右へ）
      heading -= spin * 0.07 * (i / DOTS) * (charging ? 1 : 0);
      x += Math.sin(heading) * step;
      z += Math.cos(heading) * step;
      const s = 1 - (i / DOTS) * 0.5;
      this.m.makeScale(s, 1, s).setPosition(x, 0, z);
      this.dots.setMatrixAt(i, this.m);
    }
    this.dots.instanceMatrix.needsUpdate = true;
  }

  set visible(v: boolean) {
    this.group.visible = v;
  }
}
