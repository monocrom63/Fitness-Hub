import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { Storage, type File } from "@google-cloud/storage";

const SIDECAR = "http://127.0.0.1:1106";
const storage = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${SIDECAR}/token`,
    type: "external_account",
    credential_source: {
      url: `${SIDECAR}/credential`,
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

function privateDir() {
  const value = process.env.PRIVATE_OBJECT_DIR;
  if (!value) throw new Error("Private object storage is not configured.");
  return value.endsWith("/") ? value : `${value}/`;
}

function parseObjectPath(path: string) {
  const parts = path.startsWith("/") ? path.slice(1).split("/") : path.split("/");
  if (parts.length < 2 || !parts[0] || !parts.slice(1).join("/")) {
    throw new Error("Invalid object path.");
  }
  return { bucketName: parts[0], objectName: parts.slice(1).join("/") };
}

export async function createStudioLogoUpload(studioId: number) {
  const prefix = privateDir();
  const fullPath = `${prefix}studio-logos/${studioId}/${randomUUID()}`;
  const { bucketName, objectName } = parseObjectPath(fullPath);
  const response = await fetch(`${SIDECAR}/object-storage/signed-object-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bucket_name: bucketName,
      object_name: objectName,
      method: "PUT",
      expires_at: new Date(Date.now() + 900_000).toISOString(),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Could not create upload URL (${response.status}).`);
  const { signed_url: uploadUrl } = await response.json() as { signed_url?: string };
  if (!uploadUrl) throw new Error("Storage did not return an upload URL.");
  const rawObjectPath = new URL(uploadUrl).pathname;
  if (!rawObjectPath.startsWith(prefix)) throw new Error("Upload URL points outside private storage.");
  const objectPath = `/objects/${rawObjectPath.slice(prefix.length)}`;
  return { uploadUrl, objectPath };
}

export async function getStudioLogoFile(objectPath: string): Promise<File | null> {
  if (!objectPath.startsWith("/objects/studio-logos/")) return null;
  const entity = objectPath.slice("/objects/".length);
  const { bucketName, objectName } = parseObjectPath(`${privateDir()}${entity}`);
  const file = storage.bucket(bucketName).file(objectName);
  const [exists] = await file.exists();
  return exists ? file : null;
}

export async function pipeStudioLogo(file: File, res: import("express").Response) {
  const [metadata] = await file.getMetadata();
  res.setHeader("Content-Type", metadata.contentType || "application/octet-stream");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (metadata.size) res.setHeader("Content-Length", String(metadata.size));
  Readable.from(file.createReadStream()).pipe(res);
}
