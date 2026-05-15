import { useRef, useState } from 'react';
import { Markdown } from './Markdown';
import { uploadForumImage } from '../../services/forumApi';
import { ApiError } from '../../services/authApi';

interface ComposerProps {
  initial?: string;
  submitLabel: string;
  placeholder?: string;
  onSubmit: (bodyMd: string) => void | Promise<void>;
  onCancel?: () => void;
  disabled?: boolean;
  minLength?: number;
}

const ACCEPTED_TYPES = 'image/jpeg,image/png,image/gif,image/webp';

export function Composer({
  initial = '',
  submitLabel,
  placeholder = 'Write your reply… Markdown is supported. Drag, paste, or pick an image to upload.',
  onSubmit,
  onCancel,
  disabled = false,
  minLength = 2,
}: ComposerProps) {
  const [text, setText] = useState(initial);
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const canSubmit = text.trim().length >= minLength && !disabled && !uploading;

  function insertAtCursor(snippet: string) {
    const ta = textareaRef.current;
    if (!ta) {
      setText((prev) => `${prev}${prev && !prev.endsWith('\n') ? '\n' : ''}${snippet}\n`);
      return;
    }
    const start = ta.selectionStart ?? text.length;
    const end = ta.selectionEnd ?? text.length;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const sep = before && !before.endsWith('\n') ? '\n' : '';
    const next = `${before}${sep}${snippet}\n${after}`;
    setText(next);
    // Restore caret right after the inserted snippet on the next tick.
    queueMicrotask(() => {
      const pos = before.length + sep.length + snippet.length + 1;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  }

  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;
    setUploadError(null);
    setUploading(true);
    try {
      for (const file of files) {
        if (!ACCEPTED_TYPES.split(',').includes(file.type)) {
          setUploadError(`Unsupported file type: ${file.type || 'unknown'}`);
          continue;
        }
        const res = await uploadForumImage(file);
        const altRaw = file.name.replace(/\.[a-z]+$/i, '');
        const alt = altRaw.replace(/[[\]]/g, '');
        insertAtCursor(`![${alt}](${res.url})`);
      }
    } catch (e) {
      if (e instanceof ApiError) {
        setUploadError(e.message);
      } else {
        setUploadError(e instanceof Error ? e.message : 'Upload failed');
      }
    } finally {
      setUploading(false);
    }
  }

  return (
    <div
      className={`border ${dragOver ? 'border-coral border-2' : 'border-sand'} rounded-lg overflow-hidden bg-white`}
      onDragOver={(e) => {
        if (e.dataTransfer.types?.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files?.length) return;
        e.preventDefault();
        setDragOver(false);
        const imgs = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
        void uploadFiles(imgs);
      }}
    >
      <div className="flex items-center gap-1 border-b border-sand bg-cream/40 px-2 py-1 flex-wrap">
        <button
          type="button"
          onClick={() => setTab('write')}
          className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors ${tab === 'write' ? 'bg-white text-dark-brown' : 'text-warm-gray hover:text-dark-brown'}`}
        >
          Write
        </button>
        <button
          type="button"
          onClick={() => setTab('preview')}
          className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors ${tab === 'preview' ? 'bg-white text-dark-brown' : 'text-warm-gray hover:text-dark-brown'}`}
        >
          Preview
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || uploading}
          className="px-3 py-1 rounded-md text-xs font-semibold text-warm-gray hover:text-dark-brown hover:bg-white disabled:opacity-50 disabled:cursor-not-allowed"
          title="Upload an image (or drag/paste one into the box)"
        >
          {uploading ? 'Uploading…' : '🖼️ Image'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_TYPES}
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length) void uploadFiles(files);
            // Reset so picking the same file twice still fires.
            e.target.value = '';
          }}
        />
        <div className="flex-1" />
        <span className="text-[10px] text-warm-gray">**bold** *italic* `code` ![alt](image)</span>
      </div>
      {tab === 'write' ? (
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const items = Array.from(e.clipboardData?.items ?? []);
            const images = items
              .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
              .map((it) => it.getAsFile())
              .filter((f): f is File => !!f);
            if (images.length > 0) {
              e.preventDefault();
              void uploadFiles(images);
            }
          }}
          placeholder={placeholder}
          disabled={disabled}
          className="w-full min-h-[120px] p-3 text-sm bg-white outline-none resize-y focus:bg-cream/20 disabled:opacity-60 font-mono"
        />
      ) : (
        <div className="p-3 min-h-[120px] text-sm text-dark-brown">
          {text.trim() ? <Markdown>{text}</Markdown> : <p className="text-warm-gray italic">Nothing to preview yet.</p>}
        </div>
      )}
      {uploadError && (
        <div className="px-3 py-1.5 text-xs text-red-700 bg-red-50 border-t border-red-200">
          {uploadError}
        </div>
      )}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-sand bg-cream/20">
        <span className="text-[11px] text-warm-gray">{text.length}/64000</span>
        <div className="flex-1" />
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={disabled || uploading}
            className="px-3 py-1.5 rounded-md text-xs font-heading font-bold bg-sand text-brown hover:bg-coral-light hover:text-coral transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={() => canSubmit && onSubmit(text.trim())}
          disabled={!canSubmit}
          className="px-3 py-1.5 rounded-md text-xs font-heading font-bold bg-coral text-white hover:bg-[#d4603a] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
