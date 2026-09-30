/**
 * Scalo Enterprise Edition — Copyright (c) 2026 Scalo. All rights reserved.
 * Licensed under the Scalo Enterprise License (see ee/LICENSE): source-available, NOT open source.
 * Production use requires a valid Scalo Enterprise subscription and license key.
 */
import { useState, type FormEvent } from 'react';
import { Copy, MailPlus, Trash2, Users } from 'lucide-react';
import { ACCOUNT_ROLE_LABELS } from '@scalo/shared';
import { useConfirm } from '../../../web/src/components/ConfirmDialog';
import { useToast } from '../../../web/src/components/Toast';
import { Avatar, Badge, Button, Card, CardHeader, ErrorState, Field, IconButton, Input, PageLoader, Select } from '../../../web/src/components/ui';
import { useEdition } from '../../../web/src/lib/edition';
import { fmtDate, initials } from '../../../web/src/lib/format';
import { copyText, useLoad } from '../../../web/src/lib/hooks';
import { MEMBER_ROLES, type MemberRole } from '../../shared/types';
import { eeApi } from './api';
import { EnterpriseFeatureScreen } from './EnterpriseGate';

const ROLE_HELP: Record<MemberRole, string> = {
  admin: 'Tout, y compris les paramètres et l’équipe',
  editor: 'Tunnels, emails, contacts, automatisations — pas les paramètres',
  viewer: 'Consultation uniquement',
};

const RoleSelect = ({ value, onChange, disabled, roles }: { value: MemberRole; onChange: (r: MemberRole) => void; disabled?: boolean; roles: MemberRole[] }) => (
  <Select value={value} onChange={(e) => onChange(e.target.value as MemberRole)} disabled={disabled} className="w-44" aria-label="Rôle">
    {roles.map((r) => (
      <option key={r} value={r}>
        {ACCOUNT_ROLE_LABELS[r]}
      </option>
    ))}
  </Select>
);

export function TeamSection() {
  const toast = useToast();
  const confirm = useConfirm();
  const { has, role, isAdmin, info } = useEdition();
  const licensed = has('team');
  const { data, error, loading, reload } = useLoad(() => (isAdmin ? eeApi.team() : Promise.resolve(null)), [isAdmin]);
  const [email, setEmail] = useState('');
  const [newRole, setNewRole] = useState<MemberRole>('editor');
  const [inviting, setInviting] = useState(false);
  const [link, setLink] = useState<{ email: string; url: string; sent: boolean } | null>(null);

  if (!isAdmin) {
    return (
      <Card>
        <CardHeader icon={Users} title="Équipe" description="Seuls le propriétaire et les administrateurs du compte gèrent l’équipe." />
      </Card>
    );
  }
  if (loading && !data) return <PageLoader />;
  if (error && !data) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;
  // no license and nobody to manage: the Enterprise screen. With existing members, the list stays (they can be removed).
  if (!licensed && !data.members.length && !data.invitations.length) {
    return (
      <EnterpriseFeatureScreen feature="team" icon={Users}>
        Invitez vos collaborateurs sur votre compte, chacun avec son propre accès et un rôle : administrateur, éditeur ou lecture seule.
      </EnterpriseFeatureScreen>
    );
  }

  // an administrator manages editors and readers; only the owner manages administrators
  const assignable = role === 'owner' ? MEMBER_ROLES : MEMBER_ROLES.filter((r) => r !== 'admin');
  const full = data.seats.used >= data.seats.limit;

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      if (done) toast.success(done);
      await reload();
    } catch (e) {
      toast.error(e);
    }
  };

  const invite = async (e: FormEvent) => {
    e.preventDefault();
    setInviting(true);
    try {
      const r = await eeApi.invite(email.trim(), newRole);
      setLink({ email: r.invitation.email, url: r.invite_url, sent: r.email_sent });
      setEmail('');
      await reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setInviting(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          icon={Users}
          title="Équipe"
          description="Chaque collaborateur se connecte avec son propre email et mot de passe, et agit sur ce compte selon son rôle."
          actions={licensed ? <Badge tone={full ? 'amber' : 'slate'}>{data.seats.used} / {data.seats.limit} sièges</Badge> : <Badge tone="red">Licence inactive</Badge>}
        />
        {!licensed && (
          <p className="mb-4 rounded-lg bg-amber-50 px-3.5 py-2.5 text-sm text-amber-900">
            Sans licence valide, vos collaborateurs ne peuvent plus se connecter. Vous conservez l’accès complet au compte et pouvez retirer des membres.
          </p>
        )}
        <ul className="divide-y divide-slate-100">
          <li className="flex items-center gap-3 py-2.5">
            <Avatar text={initials(data.owner.name || data.owner.email)} seed={data.owner.email} size={32} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-slate-800">{data.owner.name}</p>
              <p className="truncate text-xs text-slate-500">{data.owner.email}</p>
            </div>
            <Badge tone="brand">{ACCOUNT_ROLE_LABELS.owner}</Badge>
          </li>
          {data.members.map((m) => {
            const self = m.user_id === info?.actor.id;
            const locked = self || (role !== 'owner' && m.role === 'admin');
            return (
              <li key={m.id} className="flex items-center gap-3 py-2.5">
                <Avatar text={initials(m.name || m.email)} seed={m.email} size={32} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">
                    {m.name} {self && <span className="font-normal text-slate-400">(vous)</span>}
                  </p>
                  <p className="truncate text-xs text-slate-500">{m.email}</p>
                </div>
                {locked || !licensed ? (
                  <Badge>{ACCOUNT_ROLE_LABELS[m.role]}</Badge>
                ) : (
                  <RoleSelect value={m.role} roles={assignable} onChange={(r) => run(() => eeApi.setMemberRole(m.id, r), 'Rôle mis à jour')} />
                )}
                {!locked && (
                  <IconButton
                    icon={Trash2}
                    label="Retirer du compte"
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Retirer ${m.name || m.email} ?`,
                        message: 'Cette personne ne pourra plus se connecter. Ce qu’elle a créé reste dans le compte.',
                        confirmLabel: 'Retirer',
                      });
                      if (ok) await run(() => eeApi.removeMember(m.id), 'Membre retiré');
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      {licensed && (
        <Card>
          <CardHeader icon={MailPlus} title="Inviter un collaborateur" description="Il reçoit un lien personnel, à usage unique et valable 7 jours, pour créer son accès." />
          <form onSubmit={invite} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field label="Email" className="flex-1">
              <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="collaborateur@exemple.fr" />
            </Field>
            <Field label="Rôle" hint={undefined}>
              <RoleSelect value={newRole} roles={assignable} onChange={setNewRole} />
            </Field>
            <Button type="submit" loading={inviting} disabled={full || !email.trim()}>
              Inviter
            </Button>
          </form>
          <p className="mt-2 text-xs text-slate-500">{full ? 'Tous les sièges de votre licence sont utilisés.' : ROLE_HELP[newRole]}</p>

          {link && (
            <div className="mt-4 rounded-lg border border-brand-200 bg-brand-50 px-3.5 py-3 text-sm text-brand-900">
              <p>
                {link.sent ? `Invitation envoyée à ${link.email}.` : `Aucun email n’a pu être envoyé à ${link.email} (SMTP non configuré) : transmettez-lui ce lien.`} Il ne sera plus affiché.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1 text-xs text-slate-700">{link.url}</code>
                <Button variant="secondary" size="xs" icon={Copy} onClick={async () => (await copyText(link.url)) && toast.success('Lien copié')}>
                  Copier
                </Button>
              </div>
            </div>
          )}

          {data.invitations.length > 0 && (
            <ul className="mt-5 divide-y divide-slate-100 border-t border-slate-100">
              {data.invitations.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
                  <span className="min-w-0 flex-1 truncate text-slate-700">{i.email}</span>
                  <Badge>{ACCOUNT_ROLE_LABELS[i.role]}</Badge>
                  <span className={i.expired ? 'text-xs text-rose-600' : 'text-xs text-slate-500'}>{i.expired ? 'Expirée' : `Expire le ${fmtDate(i.expires_at)}`}</span>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={async () => {
                      try {
                        const r = await eeApi.resendInvitation(i.id);
                        setLink({ email: r.invitation.email, url: r.invite_url, sent: r.email_sent });
                        await reload();
                      } catch (e) {
                        toast.error(e);
                      }
                    }}
                  >
                    Renvoyer
                  </Button>
                  <Button variant="ghost" size="xs" onClick={() => run(() => eeApi.revokeInvitation(i.id), 'Invitation annulée')}>
                    Annuler
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
