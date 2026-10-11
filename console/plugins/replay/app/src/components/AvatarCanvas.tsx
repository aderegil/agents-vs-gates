// pixel-souls' AvatarCanvas, now drawing the three avatar styles from a replay actor's avatar spec.
import { useEffect, useRef } from "react";
import { renderAvatar, type AvatarSpec } from "../engine/avatarStyles";

interface Props {
  spec: AvatarSpec;
  size?: number;
  label: string;
}

export function AvatarCanvas({ spec, size = 96, label }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (canvasRef.current) renderAvatar(canvasRef.current, spec, size);
  }, [spec.style, spec.seed, spec.badge, spec.role, size]);

  return <canvas ref={canvasRef} className="avatar-canvas" aria-label={label} />;
}
