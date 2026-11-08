import fs from "node:fs";
import path from "node:path";
import type {AttachmentInput} from "./types.js";

export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;

/** Largest attachment a download returns: one JSON-RPC result carries it as base64 (about 4/3 the size). */
export const MAX_DOWNLOAD_SIZE = 5 * 1024 * 1024;

/** Longest base64 string that decodes to MAX_ATTACHMENT_SIZE bytes. */
export const MAX_BASE64_LENGTH = Math.ceil(MAX_ATTACHMENT_SIZE / 3) * 4;

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Decode a strict base64 string; throws on stray characters or oversize data. */
export function decodeBase64Attachment(base64: string): Buffer {
    const compact = base64.replace(/\s+/g, "");
    if (!BASE64_PATTERN.test(compact)) {
        throw new Error("Attachment base64_content is not valid base64");
    }
    const data = Buffer.from(compact, "base64");
    if (data.length > MAX_ATTACHMENT_SIZE) {
        throw new Error(`Attachment too large (${data.length} bytes, max ${MAX_ATTACHMENT_SIZE} bytes)`);
    }
    return data;
}

/**
 * Read a file from the server's disk as an attachment. Only for stdio use:
 * the path comes from tool input, so the caller must opt in. With
 * `attachmentDir` set, the resolved real path must stay inside that directory
 * (symlinks and `..` cannot escape it).
 */
export function readLocalAttachment(filePath: string, attachmentDir?: string): AttachmentInput {
    let resolved: string;
    try {
        if (attachmentDir) {
            const root = fs.realpathSync(attachmentDir);
            resolved = fs.realpathSync(path.resolve(root, filePath));
            const relative = path.relative(root, resolved);
            if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
                throw new Error("Attachment path is outside the allowed attachment directory");
            }
        } else {
            resolved = fs.realpathSync(filePath);
        }
    } catch (error) {
        if (error instanceof Error && error.message.startsWith("Attachment path")) throw error;
        throw new Error(`Attachment file not found: ${path.basename(filePath)}`);
    }

    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
        throw new Error(`Attachment is not a regular file: ${path.basename(filePath)}`);
    }
    if (stat.size > MAX_ATTACHMENT_SIZE) {
        throw new Error(`Attachment too large (${stat.size} bytes, max ${MAX_ATTACHMENT_SIZE} bytes)`);
    }

    return {
        filename: path.basename(resolved),
        base64_content: fs.readFileSync(resolved).toString("base64"),
    };
}
