export interface DownloadedAttachment {
    filename: string;
    mime_type: string;
    size: number;
    content: string; // base64
}

export interface AttachmentInput {
    filename: string;
    mime_type?: string;
    base64_content: string;
}
