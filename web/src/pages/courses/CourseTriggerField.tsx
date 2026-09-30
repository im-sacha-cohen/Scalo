import { coursesApi } from '../../lib/courses-api';
import { useLoad } from '../../lib/hooks';
import { Field, Select } from '../../components/ui';

/** Parameter of the automation trigger « Formation terminée »: one course, or any. */
export function CourseTriggerField({ value, onChange }: { value: number | null; onChange: (courseId: number | null) => void }) {
  const { data: courses } = useLoad(() => coursesApi.courses(), []);
  return (
    <Field label="Formation" hint="Quand le contact a terminé toutes les leçons publiées de la formation (une seule fois par formation).">
      <Select value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
        <option value="">Toutes les formations</option>
        {(courses ?? []).map((c) => (
          <option key={c.id} value={c.id}>
            {c.title}
          </option>
        ))}
      </Select>
    </Field>
  );
}
