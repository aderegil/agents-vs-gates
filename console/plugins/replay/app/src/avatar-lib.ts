// Library entry shared with the Teams & Avatars plugin: `vite build -c vite.avatar.config.ts` compiles this file
// (and only the avatar code it imports) to console/plugins/teams/web/avatar.js, so both plugins draw identical
// characters from the same seeds.
export {
  ACCENT, DARK, FAIL, LIGHT, PASS, PORTRAIT_H, PORTRAIT_W, drawBadge, drawSystemObject, paintPortrait,
  portraitGrid, renderAvatar, systemKind,
} from "./engine/avatarStyles";
export type { AvatarSpec, AvatarStyle, Palette, SystemKind, SystemState } from "./engine/avatarStyles";
