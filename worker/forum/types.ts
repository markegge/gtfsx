// Forum row shapes (snake_case from D1) and the JSON DTOs we expose to the SPA
// (camelCase). Kept in one place so the SQL and the API never drift.

export interface CategoryRow {
  id: string;
  title: string;
  description: string;
  sort_order: number;
  locked: number;
  created_at: number;
}

export interface ThreadRow {
  id: string;
  category_id: string;
  slug: string;
  title: string;
  author_user_id: string;
  created_at: number;
  last_post_at: number;
  post_count: number;
  view_count: number;
  pinned: number;
  locked: number;
  solved_post_id: string | null;
  deleted_at: number | null;
}

export interface PostRow {
  id: string;
  thread_id: string;
  author_user_id: string;
  body_md: string;
  upvote_count: number;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
}

export interface AuthorDto {
  id: string;
  displayName: string;
  gravatarHash: string | null; // null = user opted out; SPA renders an identicon fallback
}

export interface CategoryDto {
  id: string;
  title: string;
  description: string;
  sortOrder: number;
  locked: boolean;
  threadCount?: number;
  latestActivityAt?: number | null;
}

export interface ThreadDto {
  id: string;
  categoryId: string;
  slug: string;
  title: string;
  author: AuthorDto;
  createdAt: number;
  lastPostAt: number;
  postCount: number;
  viewCount: number;
  pinned: boolean;
  locked: boolean;
  solvedPostId: string | null;
  /** Plaintext preview of the OP body — populated by the threads-list
   *  endpoint, omitted elsewhere to keep the single-thread / search /
   *  profile payloads compact. */
  opExcerpt?: string;
}

export interface PostDto {
  id: string;
  threadId: string;
  author: AuthorDto;
  bodyMd: string;
  upvoteCount: number;
  upvotedByMe: boolean;
  isSolved: boolean;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
}

export interface ForumProfileDto {
  userId: string;
  displayName: string | null;        // forum-specific; null = needs picker
  gravatarHash: string | null;
  gravatarOptOut: boolean;
  emailPrefs: {
    replies: boolean;
    subscribed: boolean;
    markSolved: boolean;
    adminAlerts: boolean;             // only meaningful for staff
    allOff: boolean;
  };
  isStaff: boolean;
  needsDisplayName: boolean;          // true on first visit until set
}
