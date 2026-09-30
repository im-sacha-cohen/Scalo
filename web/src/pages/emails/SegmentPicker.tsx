// Newsletter editor: target a saved segment (combined with the tag). Recipients are computed when the send starts.
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../lib/api';
import { crmApi } from '../../lib/crm-api';
import { useLoad } from '../../lib/hooks';
import { useToast } from '../../components/Toast';
import { inputCls } from '../../builder/controls';

export function SegmentPicker({ broadcastId, initial, onChanged }: { broadcastId: number; initial: number | null; onChanged: () => void }) {
  const toast = useToast();
  const { data: segments } = useLoad(() => crmApi.segments(false), []);
  const [value, setValue] = useState(initial ? String(initial) : '');

  const change = async (v: string) => {
    const prev = value;
    setValue(v);
    try {
      await api.updateBroadcast(broadcastId, { segment_id: v ? Number(v) : null });
      onChanged();
    } catch (e) {
      setValue(prev);
      toast.error(e);
    }
  };

  return (
    <div className="mt-2">
      <select className={inputCls} value={value} onChange={(e) => change(e.target.value)} aria-label="Segment">
        <option value="">Aucun segment</option>
        {(segments ?? []).map((s) => (
          <option key={s.id} value={s.id}>
            Segment : {s.name}
          </option>
        ))}
      </select>
      {segments && segments.length === 0 && (
        <p className="mt-1 text-xs text-slate-400">
          <Link to="/contacts?tab=segments" className="font-medium text-brand-600 hover:underline">
            Créer un segment
          </Link>{' '}
          pour cibler précisément (tags, champs, activité…).
        </p>
      )}
    </div>
  );
}
