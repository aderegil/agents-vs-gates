// Library entry shared with the Teams & Avatars plugin: `vite build -c vite.avatar.config.ts` compiles this file
// (and only the avatar code it imports) to console/plugins/teams/web/avatar.js, so both plugins draw identical
// characters from the same seeds.
export {
  ACCENT, FAIL, LIGHT, PASS, PORTRAIT_H, PORTRAIT_W, crispWidth, drawBadge, drawSystemObject, paintPortrait,
  portraitGrid, renderAvatar, systemKind,
} from "./engine/avatarStyles";
export { agentFamily, emblemFor, humanGroup, poseKey } from "./engine/identity";
export { portraitHash, portraitPixels } from "./engine/portrait";
export type { AvatarSpec, AvatarStyle, Palette, SystemKind, SystemState } from "./engine/avatarStyles";
export type { AgentFamily, Emblem, HumanGroup, Pose } from "./engine/identity";
