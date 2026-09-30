// Courses & members area endpoints (see SPEC.md, « Formations et espace membres »).
import { LESSON_FILE_MAX_BYTES, type Course, type CourseStatus, type CourseStudent, type Lesson, type LessonFile, type MemberArea, type PageContent } from '@scalo/shared';
import { ApiError, getToken, rawRequest, request } from './api';

type Ok = { ok: true };

export interface CourseInput {
  title?: string;
  slug?: string;
  description?: string;
  image_url?: string | null;
  status?: CourseStatus;
  access_tag_id?: number | null;
  access_days?: number | null;
  purchase_url?: string | null;
}

export interface LessonInput {
  title?: string;
  content?: PageContent;
  video_url?: string | null;
  status?: CourseStatus;
  free_preview?: boolean;
  drip_days?: number;
  module_id?: number;
}

export interface EnrollInput {
  contact_id?: number;
  email?: string;
  access_at?: string;
  expires_at?: string | null;
}

export const coursesApi = {
  // members area
  area: () => request<MemberArea>('GET', '/member-area'),
  saveArea: (b: Partial<Pick<MemberArea, 'name' | 'slug' | 'logo_url' | 'color'>>) => request<MemberArea>('PUT', '/member-area', b),

  // courses
  courses: () => request<Course[]>('GET', '/courses'),
  createCourse: (title: string) => request<Course>('POST', '/courses', { title }),
  course: (id: number) => request<Course>('GET', `/courses/${id}`),
  updateCourse: (id: number, b: CourseInput) => request<Course>('PATCH', `/courses/${id}`, b),
  deleteCourse: (id: number) => request<Ok>('DELETE', `/courses/${id}`),
  reorderCourses: (ids: number[]) => request<Course[]>('POST', '/courses/reorder', { ids }),

  // modules (every call returns the refreshed course)
  createModule: (courseId: number, title: string) => request<Course>('POST', `/courses/${courseId}/modules`, { title }),
  renameModule: (id: number, title: string) => request<Course>('PATCH', `/course-modules/${id}`, { title }),
  deleteModule: (id: number) => request<Course>('DELETE', `/course-modules/${id}`),
  reorderModules: (courseId: number, ids: number[]) => request<Course>('POST', `/courses/${courseId}/modules/reorder`, { ids }),

  // lessons
  createLesson: (moduleId: number, title: string) => request<Lesson>('POST', `/course-modules/${moduleId}/lessons`, { title }),
  lesson: (id: number) => request<Lesson>('GET', `/lessons/${id}`),
  updateLesson: (id: number, b: LessonInput) => request<Lesson>('PATCH', `/lessons/${id}`, b),
  deleteLesson: (id: number) => request<Ok>('DELETE', `/lessons/${id}`),
  reorderLessons: (moduleId: number, ids: number[]) => request<Course>('POST', `/course-modules/${moduleId}/lessons/reorder`, { ids }),

  // lesson files
  uploadFile: (lessonId: number, file: File) => uploadLessonFile(lessonId, file),
  deleteFile: (id: number) => request<Ok>('DELETE', `/lesson-files/${id}`),
  downloadFile: async (id: number) => (await rawRequest('GET', `/lesson-files/${id}/download`)).blob(),

  // students
  students: (courseId: number) => request<CourseStudent[]>('GET', `/courses/${courseId}/students`),
  enroll: (courseId: number, b: EnrollInput) => request<CourseStudent[]>('POST', `/courses/${courseId}/students`, b),
  updateStudent: (courseId: number, contactId: number, b: { access_at?: string; expires_at?: string | null }) =>
    request<CourseStudent[]>('PATCH', `/courses/${courseId}/students/${contactId}`, b),
  removeStudent: (courseId: number, contactId: number, removeTag: boolean) =>
    request<Ok & { still_has_access: boolean }>('DELETE', `/courses/${courseId}/students/${contactId}${removeTag ? '?remove_tag=1' : ''}`),
};

async function uploadLessonFile(lessonId: number, file: File): Promise<LessonFile> {
  if (file.size > LESSON_FILE_MAX_BYTES) throw new ApiError(`Fichier trop lourd (${Math.round(LESSON_FILE_MAX_BYTES / 1024 / 1024)} Mo maximum)`, 413);
  const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`/api/lessons/${lessonId}/files?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers, body: file });
  } catch {
    throw new ApiError('Impossible de joindre le serveur. Vérifiez que l’API est démarrée.', 0);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data && typeof data.error === 'string' ? data.error : `Erreur ${res.status}`, res.status);
  return data as LessonFile;
}
