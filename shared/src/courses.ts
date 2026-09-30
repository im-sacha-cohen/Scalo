// Courses & members area (migration 0008): API shapes shared by the API and the web app.
import type { PageContent } from './content';

export type CourseStatus = 'draft' | 'published';

/** Branding and address of the members area of an account (`/m/<slug>`). */
export interface MemberArea {
  slug: string;
  name: string;
  logo_url: string | null;
  /** Brand colour (`#rrggbb`). */
  color: string;
  /** Public URL of the members area. */
  url: string;
  /** Owner preview link (signed, 24 h): browse the area as a member with access to everything. */
  preview_url: string;
}

export interface LessonFile {
  id: number;
  lesson_id: number;
  name: string;
  size: number;
  created_at: string;
}

export interface Lesson {
  id: number;
  course_id: number;
  module_id: number;
  title: string;
  position: number;
  status: CourseStatus;
  /** Readable by anybody (no session, no access needed). */
  free_preview: boolean;
  /** Drip: available N days after the member got access (0 = immediately). */
  drip_days: number;
  /** YouTube / Vimeo / direct video file URL shown above the content. */
  video_url: string | null;
  files_count: number;
  updated_at: string;
  /** Only on `GET /api/lessons/:id`. */
  content?: PageContent;
  files?: LessonFile[];
  /** Owner preview link of the lesson in the members area. */
  preview_url?: string;
}

export interface CourseModule {
  id: number;
  course_id: number;
  title: string;
  position: number;
  lessons: Lesson[];
}

export interface Course {
  id: number;
  title: string;
  slug: string;
  description: string;
  image_url: string | null;
  status: CourseStatus;
  /** Contacts having this tag have access to the course (contract with payments / automations). */
  access_tag_id: number | null;
  /** Tag access expires N days after the tag was given (null = never). */
  access_days: number | null;
  /** Where contacts without access are sent to buy the course (free URL). */
  purchase_url: string | null;
  position: number;
  created_at: string;
  updated_at: string;
  modules_count: number;
  lessons_count: number;
  students_count: number;
  /** Public URL of the course in the members area. */
  url: string;
  /** Owner preview link (signed, 24 h). */
  preview_url: string;
  /** Only on `GET /api/courses/:id`. */
  modules?: CourseModule[];
}

export type CourseAccessVia = 'manual' | 'tag';

export interface CourseStudent {
  contact: { id: number; email: string; first_name: string | null; last_name: string | null };
  /** How the contact got access (both are possible). */
  via: CourseAccessVia[];
  /** False when every access of the contact has expired. */
  active: boolean;
  /** Start of the drip schedule (earliest valid access). */
  access_at: string;
  expires_at: string | null;
  /** Manual enrollment, editable from the admin. */
  manual: { access_at: string; expires_at: string | null } | null;
  completed_lessons: number;
  total_lessons: number;
  percent: number;
  completed_at: string | null;
  last_activity_at: string | null;
}

/** File types accepted as lesson downloads (always served as attachments). */
export const LESSON_FILE_EXTENSIONS = [
  'pdf', 'zip', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'txt', 'csv', 'md', 'epub',
  'mp3', 'm4a', 'wav', 'mp4', 'mov', 'png', 'jpg', 'jpeg', 'gif', 'webp',
] as const;
export const LESSON_FILE_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Block types removed from lesson content: owner code (`html`) would run on the members' origin, and forms / payment
 * blocks only work inside a funnel step.
 */
export const LESSON_FORBIDDEN_BLOCKS: readonly string[] = ['html', 'form', 'checkout', 'upsell'];
