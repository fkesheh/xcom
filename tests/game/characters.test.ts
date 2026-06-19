import { describe, expect, it } from "vitest";

import {
  createCharacterMesh,
  disposeCharacter,
  setCharacterWalkPose,
} from "../../src/game/characters";
import { createWeaponModel } from "../../src/game/weapons";
import { createSkirmish } from "../../src/sim";

function figures() {
  const state = createSkirmish({
    seed: 12345,
    width: 20,
    height: 20,
    players: 1,
    enemies: 2,
  });
  const soldier = state.units.find((unit) => unit.faction === "player");
  const drone = state.units.find((unit) => unit.templateId === "drone");
  const sentinel = state.units.find((unit) => unit.templateId === "sentinel");
  if (!soldier || !drone || !sentinel) throw new Error("expected all character templates");
  return { soldier, drone, sentinel };
}

describe("procedural character walk rigs", () => {
  it("swings soldier legs in opposition and returns to idle", () => {
    const { soldier } = figures();
    const mesh = createCharacterMesh(soldier);
    const leftLeg = mesh.getObjectByName("leftLeg");
    const rightLeg = mesh.getObjectByName("rightLeg");
    const weaponArm = mesh.getObjectByName("weaponArm");

    expect(leftLeg).toBeDefined();
    expect(rightLeg).toBeDefined();
    expect(weaponArm).toBeDefined();

    setCharacterWalkPose(mesh, 0.25);
    expect(leftLeg?.rotation.x).toBeCloseTo(0.58);
    expect(rightLeg?.rotation.x).toBeCloseTo(-0.58);
    expect(mesh.position.y).toBeGreaterThan(0);

    setCharacterWalkPose(mesh, 0, 0);
    expect(leftLeg?.rotation.x).toBeCloseTo(0);
    expect(rightLeg?.rotation.x).toBeCloseTo(0);
    expect(weaponArm?.rotation.x).toBeCloseTo(0.06);
    expect(mesh.position.y).toBeCloseTo(0);
    expect(mesh.rotation.z).toBeCloseTo(0);
    disposeCharacter(mesh);
  });

  it("gives drones a hovering bank instead of humanoid leg motion", () => {
    const { drone } = figures();
    const mesh = createCharacterMesh(drone);
    const rig = mesh.getObjectByName("droneRig");

    expect(rig).toBeDefined();
    setCharacterWalkPose(mesh, 0.25);
    expect(mesh.position.y).toBeCloseTo(0.1);
    expect(rig?.rotation.x).not.toBeCloseTo(0);
    expect(rig?.rotation.z).not.toBeCloseTo(0);

    setCharacterWalkPose(mesh, 0, 0);
    expect(mesh.position.y).toBeCloseTo(0);
    expect(rig?.rotation.x).toBeCloseTo(0);
    expect(rig?.rotation.z).toBeCloseTo(0);
    disposeCharacter(mesh);
  });

  it("animates sentinel legs, arms, and hunched torso", () => {
    const { sentinel } = figures();
    const mesh = createCharacterMesh(sentinel);
    const leftLeg = mesh.getObjectByName("leftLeg");
    const rightArm = mesh.getObjectByName("rightArm");
    const torso = mesh.getObjectByName("torso");

    expect(leftLeg).toBeDefined();
    expect(rightArm).toBeDefined();
    expect(torso).toBeDefined();

    setCharacterWalkPose(mesh, 0.25);
    expect(leftLeg?.rotation.x).toBeCloseTo(0.58);
    expect(rightArm?.rotation.x).toBeCloseTo(0.2);
    expect(torso?.rotation.x).toBeGreaterThan(0.34);

    setCharacterWalkPose(mesh, 0, 0);
    expect(leftLeg?.rotation.x).toBeCloseTo(0);
    expect(rightArm?.rotation.x).toBeCloseTo(0);
    expect(torso?.rotation.x).toBeCloseTo(0.34);
    disposeCharacter(mesh);
  });
});

describe("procedural weapon models", () => {
  it.each(["rifle", "pistol", "plasma"] as const)("%s has a forward muzzle marker", (weaponId) => {
    const weapon = createWeaponModel(weaponId);
    const muzzle = weapon.getObjectByName("weaponMuzzle");

    expect(weapon.userData.weaponId).toBe(weaponId);
    expect(muzzle).toBeDefined();
    expect(muzzle?.position.z).toBeGreaterThan(0.4);
    disposeCharacter(weapon);
  });

  it("equips soldiers, drones, and sentinels with their configured weapon", () => {
    const { soldier, drone, sentinel } = figures();
    const units = [soldier, drone, sentinel];

    for (const unit of units) {
      const character = createCharacterMesh(unit);
      const weapon = character.getObjectByName("weaponModel");
      const muzzle = character.getObjectByName("weaponMuzzle");

      expect(weapon?.userData.weaponId).toBe(unit.weaponId);
      expect(muzzle).toBeDefined();
      disposeCharacter(character);
    }
  });

  it("supports a soldier equipped with the sidearm", () => {
    const { soldier } = figures();
    const character = createCharacterMesh({ ...soldier, weaponId: "pistol" });

    expect(character.getObjectByName("weaponModel")?.userData.weaponId).toBe("pistol");
    expect(character.getObjectByName("weaponMuzzle")).toBeDefined();
    disposeCharacter(character);
  });
});
