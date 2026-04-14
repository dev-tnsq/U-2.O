import { createHash, randomBytes } from "node:crypto";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function generateOpaqueToken(prefix: string = "u"): string {
  return `${prefix}_${randomBytes(24).toString("hex")}`;
}