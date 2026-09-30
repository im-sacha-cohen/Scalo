import { useState, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleCheck,
  Ellipsis,
  Plus,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignStart,
  TriangleAlert,
  X,
} from 'lucide-react';
import {
  BLOCK_LABELS,
  COLUMN_PRESETS,
  GOOGLE_FONTS,
  SHADOWS,
  SOCIAL_NETWORKS,
  type Block,
  type BlockStyle,
  type BlockType,
  type ButtonBlock,
  type Campaign,
  type ColumnsBlock,
  type ContactField,
  type CountdownBlock,
  type DividerBlock,
  type FaqBlock,
  type FeatureBlock,
  type FooterBlock,
  type FormBlock,
  type HeadingBlock,
  type HtmlBlock,
  type ImageBlock,
  type ImageTextBlock,
  type ListBlock,
  type NavbarBlock,
  type PageSettings,
  type PricingBlock,
  type ProgressBlock,
  type QuoteBlock,
  type RatingBlock,
  type SectionBlock,
  type SocialBlock,
  type SocialNetwork,
  type SpacerBlock,
  type Tag,
  type TestimonialBlock,
  type TextBlock,
  type VideoBlock,
} from '@scalo/shared';
import { cx } from '../components/ui';
import { useBuilder, type BuilderMode } from './context';
import { Check, ColorInput, Disclosure, Group, ImageField, NumberPair, Prop, RangeInput, Segmented, inputCls, textareaCls } from './controls';
import { BLOCK_ICONS, fontLabel, fontOptions } from './meta';
import { RichField } from './rich';
import { CheckoutProps, UpsellProps } from './PaymentProps';
import { AiRewrite } from '../pages/ai/AiRewrite';
import { Braces } from 'lucide-react';
import { useLoad } from '../lib/hooks';
import { crmApi } from '../lib/crm-api';

type Setter<T> = (patch: Partial<T>, merge?: boolean) => void;

interface InspectorProps {
  mode: BuilderMode;
  block: Block;
  path: Block[];
  settings: PageSettings;
  tags: Tag[];
  campaigns: Campaign[];
  onClose: () => void;
  className?: string;
}

/** Right panel, shown only while a block is selected (page settings live in the left rail). */
export function Inspector(props: InspectorProps) {
  return (
    <aside className={cx('flex shrink-0 flex-col border-l border-slate-200 bg-white', props.className ?? 'w-[320px]')}>
      <BlockPanel key={props.block.id} {...props} />
    </aside>
  );
}

/* ---------------- block panel ---------------- */

const TEXT_TYPES: BlockType[] = ['heading', 'text', 'list', 'quote', 'footer'];

function BlockPanel({ mode, block, path, settings, tags, campaigns, onClose }: InspectorProps) {
  const { ops, openMedia, openContextMenu } = useBuilder();
  const [tab, setTab] = useState<'content' | 'style'>('content');
  const Icon = BLOCK_ICONS[block.type];
  const set = <T extends Block>(patch: Partial<T>, merge?: boolean) =>
    ops.update(block.id, patch as Partial<Block>, merge ? `${block.id}:${Object.keys(patch).join(',')}` : undefined);
  const setStyle = (patch: Partial<BlockStyle>, merge?: boolean) =>
    ops.updateStyle(block.id, patch, merge ? `${block.id}:style:${Object.keys(patch).join(',')}` : undefined);
  const browse = (apply: (url: string) => void) => () => openMedia(apply);

  let body: ReactNode = null;
  const p = { mode, settings, browse } as const;
  switch (block.type) {
    case 'heading': body = <HeadingProps b={block} set={set as Setter<HeadingBlock>} />; break;
    case 'text': body = <TextProps b={block} set={set as Setter<TextBlock>} />; break;
    case 'list': body = <ListProps b={block} set={set as Setter<ListBlock>} />; break;
    case 'image': body = <ImageProps b={block} set={set as Setter<ImageBlock>} {...p} />; break;
    case 'button': body = <ButtonProps b={block} set={set as Setter<ButtonBlock>} {...p} />; break;
    case 'form': body = <FormProps b={block} set={set as Setter<FormBlock>} settings={settings} tags={tags} campaigns={campaigns} />; break;
    case 'video': body = <VideoProps b={block} set={set as Setter<VideoBlock>} mode={mode} />; break;
    case 'spacer': body = <SpacerProps b={block} set={set as Setter<SpacerBlock>} />; break;
    case 'divider': body = <DividerProps b={block} set={set as Setter<DividerBlock>} />; break;
    case 'section': body = <SectionProps b={block} set={set as Setter<SectionBlock>} {...p} />; break;
    case 'columns': body = <ColumnsProps b={block} set={set as Setter<ColumnsBlock>} onPreset={(w) => ops.setColumnWidths(block.id, w)} />; break;
    case 'countdown': body = <CountdownProps b={block} set={set as Setter<CountdownBlock>} />; break;
    case 'testimonial': body = <TestimonialProps b={block} set={set as Setter<TestimonialBlock>} {...p} />; break;
    case 'pricing': body = <PricingProps b={block} set={set as Setter<PricingBlock>} {...p} />; break;
    case 'faq': body = <FaqProps b={block} set={set as Setter<FaqBlock>} />; break;
    case 'feature': body = <FeatureProps b={block} set={set as Setter<FeatureBlock>} settings={settings} />; break;
    case 'social': body = <SocialProps b={block} set={set as Setter<SocialBlock>} />; break;
    case 'imageText': body = <ImageTextProps b={block} set={set as Setter<ImageTextBlock>} {...p} />; break;
    case 'progress': body = <ProgressProps b={block} set={set as Setter<ProgressBlock>} settings={settings} />; break;
    case 'navbar': body = <NavbarProps b={block} set={set as Setter<NavbarBlock>} {...p} />; break;
    case 'footer': body = <FooterProps b={block} set={set as Setter<FooterBlock>} />; break;
    case 'html': body = <HtmlProps b={block} set={set as Setter<HtmlBlock>} mode={mode} />; break;
    case 'rating': body = <RatingProps b={block} set={set as Setter<RatingBlock>} />; break;
    case 'quote': body = <QuoteProps b={block} set={set as Setter<QuoteBlock>} settings={settings} />; break;
    case 'checkout': body = <CheckoutProps b={block} set={set as Setter<typeof block>} settings={settings} />; break;
    case 'upsell': body = <UpsellProps b={block} set={set as Setter<typeof block>} settings={settings} />; break;
  }

  const isLayout = block.type === 'section' || block.type === 'columns';
  return (
    <>
      <div className="shrink-0 border-b border-slate-200">
        {/* breadcrumb of the selection */}
        <nav className="flex h-8 items-center gap-0.5 overflow-hidden px-3 pt-1 text-[11px] text-slate-400" aria-label="Emplacement du bloc">
          <button type="button" onClick={() => ops.select(null)} className="shrink-0 rounded px-1 py-0.5 hover:bg-slate-100 hover:text-slate-700">
            {mode === 'email' ? 'Email' : 'Page'}
          </button>
          {path.map((b) => (
            <span key={b.id} className="flex min-w-0 items-center gap-0.5">
              <ChevronRight size={11} className="shrink-0 text-slate-300" />
              <button type="button" onClick={() => ops.select(b.id)} className="truncate rounded px-1 py-0.5 hover:bg-slate-100 hover:text-slate-700">
                {BLOCK_LABELS[b.type]}
              </button>
            </span>
          ))}
        </nav>
        <div className="flex h-10 items-center gap-2 pr-2 pl-4">
          <Icon size={16} className="shrink-0 text-brand-600" />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">{BLOCK_LABELS[block.type]}</span>
          <button
            type="button"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              openContextMenu(block.id, r.right - 240, r.bottom + 4);
            }}
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            title="Actions (dupliquer, copier, supprimer…)"
            aria-label="Actions du bloc"
          >
            <Ellipsis size={16} />
          </button>
          <button type="button" onClick={onClose} className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="Fermer (Échap)" aria-label="Fermer">
            <X size={16} />
          </button>
        </div>
        <div className="px-4 pt-1 pb-3">
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'content', label: isLayout ? 'Mise en page' : 'Contenu' },
              { value: 'style', label: 'Style' },
            ]}
          />
        </div>
      </div>
      <div className="scalo-scroll flex-1 overflow-y-auto">
        {tab === 'content' ? <div className="space-y-4 px-4 py-4">{body}</div> : <StyleTab block={block} settings={settings} setStyle={setStyle} mode={mode} />}
      </div>
    </>
  );
}

/* ---------------- basic blocks ---------------- */

function HeadingProps({ b, set }: { b: HeadingBlock; set: Setter<HeadingBlock> }) {
  return (
    <>
      <Prop label="Niveau">
        <Segmented
          value={b.level}
          onChange={(level) => set({ level })}
          options={[
            { value: 1, label: 'H1', title: 'Titre principal' },
            { value: 2, label: 'H2', title: 'Sous-titre' },
            { value: 3, label: 'H3', title: 'Petit titre' },
          ]}
        />
      </Prop>
      <Prop label="Texte" hint="Double-cliquez sur le titre pour l’éditer directement sur la page.">
        <RichField value={b.text} onChange={(text) => set({ text }, true)} minHeight={56} primary />
        <AiRewrite value={b.text} onChange={(text) => set({ text })} />
      </Prop>
    </>
  );
}

function TextProps({ b, set }: { b: TextBlock; set: Setter<TextBlock> }) {
  return (
    <Prop label="Texte" hint="Double-cliquez sur le texte de la page pour l’éditer directement.">
      <RichField value={b.text} onChange={(text) => set({ text }, true)} minHeight={140} primary />
      <AiRewrite value={b.text} onChange={(text) => set({ text })} />
    </Prop>
  );
}

function ItemsEditor<T>({
  items,
  onChange,
  render,
  create,
  addLabel,
  min = 1,
}: {
  items: T[];
  onChange: (items: T[], merge?: boolean) => void;
  render: (item: T, update: (v: T, merge?: boolean) => void, i: number) => ReactNode;
  create: () => T;
  addLabel: string;
  min?: number;
}) {
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    const n = items.slice();
    [n[i], n[j]] = [n[j]!, n[i]!];
    onChange(n);
  };
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <div key={i} className="group rounded-lg border border-slate-200 bg-slate-50/60 p-2">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-400">#{i + 1}</span>
            <div className="flex opacity-50 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
              <MiniBtn title="Monter" disabled={i === 0} onClick={() => move(i, -1)}>
                <ChevronUp size={14} />
              </MiniBtn>
              <MiniBtn title="Descendre" disabled={i === items.length - 1} onClick={() => move(i, 1)}>
                <ChevronDown size={14} />
              </MiniBtn>
              <MiniBtn title="Supprimer" danger disabled={items.length <= min} onClick={() => onChange(items.filter((_, k) => k !== i))}>
                <X size={14} />
              </MiniBtn>
            </div>
          </div>
          {render(it, (v, merge) => onChange(items.map((x, k) => (k === i ? v : x)), merge), i)}
        </div>
      ))}
      <AddRow onClick={() => onChange([...items, create()])}>{addLabel}</AddRow>
    </div>
  );
}

function ListProps({ b, set }: { b: ListBlock; set: Setter<ListBlock> }) {
  const items = Array.isArray(b.items) ? b.items : [];
  return (
    <>
      <Prop label="Puce">
        <select className={inputCls} value={b.icon ?? 'dot'} onChange={(e) => set({ icon: e.target.value as ListBlock['icon'] })}>
          <option value="check">✓ Coche</option>
          <option value="dot">• Puce</option>
          <option value="number">1. Numéro</option>
          <option value="arrow">→ Flèche</option>
          <option value="star">★ Étoile</option>
        </select>
      </Prop>
      <Prop label={`Éléments (${items.length})`}>
        <ItemsEditor
          items={items}
          onChange={(n, merge) => set({ items: n }, merge)}
          create={() => 'Nouvel élément'}
          addLabel="Ajouter un élément"
          render={(it, update) => <RichField value={it} onChange={(v) => update(v, true)} singleLine compact />}
        />
      </Prop>
    </>
  );
}

type WithMedia = { mode: BuilderMode; settings: PageSettings; browse: (apply: (url: string) => void) => () => void };

function ImageProps({ b, set, browse }: { b: ImageBlock; set: Setter<ImageBlock> } & WithMedia) {
  return (
    <>
      <Prop label="Image">
        <ImageField value={b.src} onChange={(src) => set({ src }, true)} onBrowse={browse((src) => set({ src }))} />
      </Prop>
      <Prop label="Texte alternatif" hint="Décrit l’image (accessibilité, SEO, emails bloquant les images).">
        <input className={inputCls} value={b.alt ?? ''} placeholder="Description de l’image" onChange={(e) => set({ alt: e.target.value }, true)} />
      </Prop>
      <Prop label="Largeur">
        <RangeInput value={b.width ?? 100} min={10} max={100} unit="%" onChange={(width) => set({ width }, true)} />
      </Prop>
      <Prop label="Arrondi des angles">
        <RangeInput value={b.radius} placeholder={8} min={0} max={200} onChange={(radius) => set({ radius }, true)} onReset={() => set({ radius: undefined })} />
      </Prop>
      <Prop label="Lien au clic (optionnel)">
        <input className={inputCls} value={b.href ?? ''} placeholder="https://…" onChange={(e) => set({ href: e.target.value || undefined }, true)} />
      </Prop>
    </>
  );
}

function ActionFields({ mode, action, url, onAction, onUrl, newTab, onNewTab }: { mode: BuilderMode; action: 'next' | 'url' | undefined; url?: string; onAction: (a: 'next' | 'url') => void; onUrl: (u: string) => void; newTab?: boolean; onNewTab?: (v: boolean) => void }) {
  const isUrl = mode === 'email' || action === 'url';
  return (
    <>
      {mode === 'page' && (
        <Prop label="Action au clic">
          <Segmented
            value={action ?? 'next'}
            onChange={onAction}
            options={[
              { value: 'next', label: 'Étape suivante' },
              { value: 'url', label: 'Lien' },
            ]}
          />
        </Prop>
      )}
      {isUrl ? (
        <Prop label="URL de destination" hint={mode === 'page' ? '« #inscription » fait défiler vers une ancre de la page.' : undefined}>
          <input className={inputCls} value={url ?? ''} placeholder="https://…" onChange={(e) => onUrl(e.target.value)} />
        </Prop>
      ) : (
        <p className="-mt-2 text-xs text-slate-500">Le visiteur passe à l’étape suivante du tunnel.</p>
      )}
      {isUrl && mode === 'page' && onNewTab && <Check checked={!!newTab} onChange={onNewTab} label="Ouvrir dans un nouvel onglet" />}
    </>
  );
}

function ButtonProps({ b, set, mode, settings }: { b: ButtonBlock; set: Setter<ButtonBlock> } & WithMedia) {
  return (
    <>
      <Prop label="Texte du bouton">
        <RichField value={b.label} onChange={(label) => set({ label }, true)} singleLine compact primary />
      </Prop>
      <ActionFields mode={mode} action={b.action} url={b.url} onAction={(action) => set({ action })} onUrl={(url) => set({ url }, true)} newTab={b.newTab} onNewTab={(newTab) => set({ newTab })} />
      <Prop label="Taille">
        <Segmented
          value={b.size ?? 'md'}
          onChange={(size) => set({ size })}
          options={[
            { value: 'sm', label: 'Petit' },
            { value: 'md', label: 'Moyen' },
            { value: 'lg', label: 'Grand' },
          ]}
        />
      </Prop>
      <Prop label="Apparence">
        <Segmented
          value={b.variant ?? 'solid'}
          onChange={(variant) => set({ variant })}
          options={[
            { value: 'solid', label: 'Plein' },
            { value: 'outline', label: 'Contour' },
          ]}
        />
      </Prop>
      <Check checked={!!b.fullWidth} onChange={(fullWidth) => set({ fullWidth })} label="Pleine largeur" />
      <Disclosure title="Couleurs et arrondi" id="button-look">
        <Prop label="Couleur du bouton">
          <ColorInput value={b.bg} placeholder={settings.accent} onChange={(bg) => set({ bg }, true)} />
        </Prop>
        <Prop label="Couleur du texte">
          <ColorInput value={b.textColor} placeholder="#ffffff" onChange={(textColor) => set({ textColor }, true)} />
        </Prop>
        <Prop label="Arrondi">
          <RangeInput value={b.radius} placeholder={8} min={0} max={40} onChange={(radius) => set({ radius }, true)} onReset={() => set({ radius: undefined })} />
        </Prop>
      </Disclosure>
    </>
  );
}

const FIELD_LABELS: Record<ContactField, string> = { email: 'Email', first_name: 'Prénom', last_name: 'Nom', phone: 'Téléphone' };
const FIELD_DEFAULT_LABELS: Record<ContactField, string> = { email: 'Votre email', first_name: 'Votre prénom', last_name: 'Votre nom', phone: 'Votre téléphone' };

function FormProps({ b, set, settings, tags, campaigns }: { b: FormBlock; set: Setter<FormBlock>; settings: PageSettings; tags: Tag[]; campaigns: Campaign[] }) {
  const fields = Array.isArray(b.fields) ? b.fields : [];
  const used = new Set(fields.map((f) => f.name));
  const remaining = (Object.keys(FIELD_LABELS) as ContactField[]).filter((f) => !used.has(f));
  // custom fields of the account: inputs `field.<key>` (type and list options copied into the block)
  const { data: customDefs } = useLoad(() => crmApi.customFields(), []);
  const remainingCustom = (customDefs ?? []).filter((d) => !used.has(`field.${d.key}`));
  const setFields = (next: FormBlock['fields'], merge?: boolean) => set({ fields: next }, merge);
  const patchField = (i: number, patch: Partial<FormBlock['fields'][number]>, merge?: boolean) => setFields(fields.map((f, k) => (k === i ? { ...f, ...patch } : f)), merge);
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= fields.length) return;
    const n = fields.slice();
    [n[i], n[j]] = [n[j]!, n[i]!];
    setFields(n);
  };
  const listId = `tags-${b.id}`;

  return (
    <>
      <Prop label="Champs du formulaire">
        <div className="space-y-2">
          {fields.map((f, i) => (
            <div key={f.name} className="rounded-lg border border-slate-200 bg-slate-50/60 p-2">
              <div className="mb-2 flex items-center gap-1">
                {f.name.startsWith('field.') ? (
                  // custom contact field (Contacts → Champs personnalisés)
                  <span className="flex h-8 min-w-0 flex-1 items-center gap-1.5 truncate px-1 text-[13px] font-medium text-slate-700" title={`{{${f.name}}}`}>
                    <Braces size={13} className="shrink-0 text-brand-500" />
                    {customDefs?.find((d) => `field.${d.key}` === f.name)?.label ?? f.name.slice(6)}
                  </span>
                ) : (
                <select
                  className={cx(inputCls, 'h-8 flex-1 font-medium')}
                  value={f.name}
                  onChange={(e) => {
                    const name = e.target.value as ContactField;
                    patchField(i, { name, label: FIELD_DEFAULT_LABELS[name], required: name === 'email' ? true : f.required });
                  }}
                >
                  {(Object.keys(FIELD_LABELS) as ContactField[]).map((n) => (
                    <option key={n} value={n} disabled={n !== f.name && used.has(n)}>
                      {FIELD_LABELS[n]}
                    </option>
                  ))}
                </select>
                )}
                <MiniBtn title="Monter" disabled={i === 0} onClick={() => move(i, -1)}>
                  <ChevronUp size={14} />
                </MiniBtn>
                <MiniBtn title="Descendre" disabled={i === fields.length - 1} onClick={() => move(i, 1)}>
                  <ChevronDown size={14} />
                </MiniBtn>
                <MiniBtn title={f.name === 'email' ? 'Le champ email est obligatoire' : 'Supprimer'} danger disabled={f.name === 'email'} onClick={() => setFields(fields.filter((_, k) => k !== i))}>
                  <X size={14} />
                </MiniBtn>
              </div>
              <input className={cx(inputCls, 'h-8')} value={f.label} placeholder="Texte indicatif" onChange={(e) => patchField(i, { label: e.target.value }, true)} />
              <div className="mt-2">
                <Check
                  checked={f.name === 'email' || !!f.required}
                  onChange={(required) => f.name !== 'email' && patchField(i, { required })}
                  label={f.name === 'email' ? 'Obligatoire (toujours)' : 'Obligatoire'}
                />
              </div>
            </div>
          ))}
          {!used.has('email') && (
            <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-2.5 py-2 text-xs text-amber-800">
              <TriangleAlert size={14} className="mt-px shrink-0" /> Ajoutez un champ email : il est nécessaire pour créer le contact.
            </p>
          )}
          {remaining.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {remaining.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setFields([...fields, { name: n, label: FIELD_DEFAULT_LABELS[n], required: n === 'email' }])}
                  className="inline-flex items-center gap-1 rounded-md border border-dashed border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:border-brand-400 hover:bg-brand-50 hover:text-brand-700"
                >
                  <Plus size={12} /> {FIELD_LABELS[n]}
                </button>
              ))}
            </div>
          )}
          {remainingCustom.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {remainingCustom.map((d) => (
                <button
                  key={d.key}
                  type="button"
                  title={`Champ personnalisé {{field.${d.key}}}`}
                  onClick={() => setFields([...fields, { name: `field.${d.key}`, label: d.label, input: d.type, ...(d.type === 'select' ? { options: d.options } : {}) }])}
                  className="inline-flex items-center gap-1 rounded-md border border-dashed border-brand-200 px-2 py-1 text-xs font-medium text-brand-700 hover:border-brand-400 hover:bg-brand-50"
                >
                  <Plus size={12} /> {d.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </Prop>
      <Prop label="Texte du bouton">
        <input className={inputCls} value={b.submitLabel} onChange={(e) => set({ submitLabel: e.target.value }, true)} data-primary-field="" />
      </Prop>
      <Disclosure title="Apparence" id="form-look">
        <Prop label="Couleur du bouton">
          <ColorInput value={b.buttonBg} placeholder={settings.accent} onChange={(buttonBg) => set({ buttonBg }, true)} />
        </Prop>
        <Prop label="Couleur du texte du bouton">
          <ColorInput value={b.buttonColor} placeholder="#ffffff" onChange={(buttonColor) => set({ buttonColor }, true)} />
        </Prop>
        <Prop label="Arrondi des champs">
          <RangeInput value={b.inputRadius} placeholder={8} min={0} max={40} onChange={(inputRadius) => set({ inputRadius }, true)} onReset={() => set({ inputRadius: undefined })} />
        </Prop>
      </Disclosure>
      <Disclosure title="Après l’inscription" id="form-automation" defaultOpen>
      <Prop
        label="Tag à ajouter au contact"
        hint={
          b.doubleOptin === true
            ? 'Créé automatiquement s’il n’existe pas. Avec le double opt-in, le tag et la campagne sont appliqués quand le contact confirme.'
            : 'Créé automatiquement s’il n’existe pas. Le contact est créé (ou mis à jour) puis redirigé vers l’étape suivante du tunnel.'
        }
      >
        <input className={inputCls} list={listId} value={b.tagName ?? ''} placeholder="ex. lead" onChange={(e) => set({ tagName: e.target.value || undefined }, true)} />
        <datalist id={listId}>
          {tags.map((t) => (
            <option key={t.id} value={t.name} />
          ))}
        </datalist>
      </Prop>
      <Prop label="Inscrire à la campagne email">
        <select className={inputCls} value={b.campaignId ?? ''} onChange={(e) => set({ campaignId: e.target.value ? Number(e.target.value) : undefined })}>
          <option value="">Aucune campagne</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
          {b.campaignId && !campaigns.some((c) => c.id === b.campaignId) && <option value={b.campaignId}>Campagne #{b.campaignId}</option>}
        </select>
      </Prop>
      <Prop
        label="Double opt-in"
        hint="Le contact confirme son adresse via un lien reçu par email avant de recevoir vos emails. Il est créé « en attente de confirmation » et redirigé vers l’étape suivante (« Vérifiez votre boîte mail »)."
      >
        <select
          className={inputCls}
          value={b.doubleOptin === undefined ? '' : b.doubleOptin ? 'on' : 'off'}
          onChange={(e) => set({ doubleOptin: e.target.value === '' ? undefined : e.target.value === 'on' })}
        >
          <option value="">Par défaut du compte (Paramètres)</option>
          <option value="on">Activé</option>
          <option value="off">Désactivé</option>
        </select>
      </Prop>
      </Disclosure>
      {b.doubleOptin !== false && (
        <Disclosure title="Email de confirmation" id="form-doi">
          <Prop label="Objet de l’email de confirmation">
            <input className={inputCls} value={b.doubleOptinSubject ?? ''} placeholder="Confirmez votre inscription" onChange={(e) => set({ doubleOptinSubject: e.target.value || undefined }, true)} />
          </Prop>
          <Prop label="Texte de l’email de confirmation" hint="Un paragraphe par ligne. {{first_name}} possible. Le bouton « Confirmer mon inscription » est ajouté automatiquement.">
            <textarea
              className={textareaCls}
              rows={4}
              value={b.doubleOptinText ?? ''}
              placeholder={'Bonjour {{first_name}},\nMerci pour votre inscription ! Confirmez votre adresse en cliquant sur le bouton ci-dessous.'}
              onChange={(e) => set({ doubleOptinText: e.target.value || undefined }, true)}
            />
          </Prop>
          <Prop label="Page après confirmation" hint="Facultatif (https://…). Par défaut : une page « Inscription confirmée ».">
            <input className={inputCls} value={b.doubleOptinRedirect ?? ''} placeholder="https://…" onChange={(e) => set({ doubleOptinRedirect: e.target.value.trim() || undefined }, true)} />
          </Prop>
        </Disclosure>
      )}
    </>
  );
}

function VideoProps({ b, set, mode }: { b: VideoBlock; set: Setter<VideoBlock>; mode: BuilderMode }) {
  const ok = /(youtube\.com\/(watch\?v=|embed\/|shorts\/)|youtu\.be\/|vimeo\.com\/)/.test(b.url ?? '');
  return (
    <>
      <Prop label="URL de la vidéo" hint={mode === 'email' ? 'Dans un email, la vignette de la vidéo renvoie vers la vidéo.' : 'YouTube (watch, youtu.be, shorts) ou Vimeo.'}>
        <input className={inputCls} value={b.url} placeholder="https://www.youtube.com/watch?v=…" onChange={(e) => set({ url: e.target.value.trim() }, true)} data-primary-field="" />
      </Prop>
      {b.url && (
        <p className={cx('flex items-center gap-1.5 text-xs', ok ? 'text-emerald-600' : 'text-amber-700')}>
          {ok ? <CircleCheck size={14} /> : <TriangleAlert size={14} />}
          {ok ? 'Vidéo reconnue' : 'Lien non reconnu : un simple lien sera affiché'}
        </p>
      )}
    </>
  );
}

function SpacerProps({ b, set }: { b: SpacerBlock; set: Setter<SpacerBlock> }) {
  return (
    <Prop label="Hauteur">
      <RangeInput value={b.height} min={4} max={320} onChange={(height) => set({ height }, true)} />
    </Prop>
  );
}

function DividerProps({ b, set }: { b: DividerBlock; set: Setter<DividerBlock> }) {
  return (
    <>
      <Prop label="Couleur de la ligne">
        <ColorInput value={b.color} placeholder="#e2e8f0" onChange={(color) => set({ color }, true)} />
      </Prop>
      <Prop label="Épaisseur">
        <RangeInput value={b.thickness} placeholder={1} min={1} max={12} onChange={(thickness) => set({ thickness }, true)} />
      </Prop>
      <Prop label="Style">
        <Segmented
          value={b.lineStyle ?? 'solid'}
          onChange={(lineStyle) => set({ lineStyle })}
          options={[
            { value: 'solid', label: 'Pleine' },
            { value: 'dashed', label: 'Tirets' },
            { value: 'dotted', label: 'Points' },
          ]}
        />
      </Prop>
      <Prop label="Largeur">
        <RangeInput value={b.width ?? 100} min={10} max={100} unit="%" onChange={(width) => set({ width }, true)} />
      </Prop>
    </>
  );
}

/* ---------------- layout ---------------- */

function SectionProps({ b, set, mode, browse }: { b: SectionBlock; set: Setter<SectionBlock> } & WithMedia) {
  const grad = b.gradient;
  return (
    <>
      {mode === 'page' && (
        <Prop label="Largeur du fond">
          <Segmented
            value={b.fullWidth ? 'full' : 'boxed'}
            onChange={(v) => set({ fullWidth: v === 'full' })}
            options={[
              { value: 'boxed', label: 'Encadré' },
              { value: 'full', label: 'Toute la largeur' },
            ]}
          />
        </Prop>
      )}
      <Prop label="Largeur max. du contenu" hint="Vide = largeur de la page.">
        <RangeInput value={b.contentWidth} placeholder={mode === 'email' ? 600 : 880} min={280} max={1600} step={10} onChange={(contentWidth) => set({ contentWidth }, true)} onReset={() => set({ contentWidth: undefined })} />
      </Prop>
      {mode === 'page' && (
        <>
          <Prop label="Hauteur minimale">
            <RangeInput value={b.minHeight} placeholder={0} min={0} max={1200} step={10} onChange={(minHeight) => set({ minHeight: minHeight || undefined }, true)} onReset={() => set({ minHeight: undefined })} />
          </Prop>
          {!!b.minHeight && (
            <Prop label="Alignement vertical">
              <Segmented
                value={b.valign ?? 'center'}
                onChange={(valign) => set({ valign })}
                options={[
                  { value: 'top', label: 'Haut' },
                  { value: 'center', label: 'Centre' },
                  { value: 'bottom', label: 'Bas' },
                ]}
              />
            </Prop>
          )}
        </>
      )}
      <Disclosure title="Arrière-plan" id="section-bg" defaultOpen>
      <p className="-mt-1 text-xs text-slate-400">Couleur unie : onglet Style.</p>
      <Check checked={!!grad} onChange={(on) => set({ gradient: on ? { from: '#5b4bff', to: '#0ea5e9', angle: 135 } : undefined })} label="Dégradé" />
      {grad && (
        <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/60 p-2.5">
          <div className="h-8 rounded-md" style={{ background: `linear-gradient(${grad.angle}deg, ${grad.from}, ${grad.to})` }} />
          <Prop label="Couleur de départ">
            <ColorInput value={grad.from} allowClear={false} onChange={(from) => from && set({ gradient: { ...grad, from } }, true)} />
          </Prop>
          <Prop label="Couleur d’arrivée">
            <ColorInput value={grad.to} allowClear={false} onChange={(to) => to && set({ gradient: { ...grad, to } }, true)} />
          </Prop>
          <Prop label="Angle">
            <RangeInput value={grad.angle} min={0} max={360} unit="°" onChange={(angle) => set({ gradient: { ...grad, angle } }, true)} />
          </Prop>
        </div>
      )}
      <Prop label="Image de fond">
        <ImageField value={b.bgImage} compact onChange={(bgImage) => set({ bgImage: bgImage || undefined }, true)} onBrowse={browse((bgImage) => set({ bgImage }))} />
      </Prop>
      {b.bgImage && (
        <>
          <Prop label="Ajustement">
            <Segmented
              value={b.bgSize ?? 'cover'}
              onChange={(bgSize) => set({ bgSize })}
              options={[
                { value: 'cover', label: 'Remplir' },
                { value: 'contain', label: 'Contenir' },
              ]}
            />
          </Prop>
          <Prop label="Position">
            <Segmented
              value={b.bgPosition ?? 'center'}
              onChange={(bgPosition) => set({ bgPosition })}
              options={[
                { value: 'top', label: 'Haut' },
                { value: 'center', label: 'Centre' },
                { value: 'bottom', label: 'Bas' },
              ]}
            />
          </Prop>
        </>
      )}
      {mode === 'page' && (
        <>
          <Prop label="Voile (overlay)">
            <ColorInput value={b.overlayColor} placeholder="Aucun" onChange={(overlayColor) => set({ overlayColor, overlayOpacity: overlayColor ? (b.overlayOpacity ?? 50) : undefined }, true)} />
          </Prop>
          {b.overlayColor && (
            <Prop label="Opacité du voile">
              <RangeInput value={b.overlayOpacity ?? 50} min={0} max={100} unit="%" onChange={(overlayOpacity) => set({ overlayOpacity }, true)} />
            </Prop>
          )}
        </>
      )}
      </Disclosure>
    </>
  );
}

function ColumnsProps({ b, set, onPreset }: { b: ColumnsBlock; set: Setter<ColumnsBlock>; onPreset: (w: number[]) => void }) {
  const cols = Array.isArray(b.columns) ? b.columns : [];
  const current = cols.map((c) => Math.round(c.width)).join('-');
  return (
    <>
      <Prop label="Disposition">
        <div className="grid grid-cols-4 gap-1.5">
          {COLUMN_PRESETS.map((p) => {
            const active = p.widths.map((w) => Math.round(w)).join('-') === current;
            return (
              <button
                key={p.id}
                type="button"
                title={p.label}
                onClick={() => onPreset(p.widths)}
                className={cx('flex h-9 gap-0.5 rounded-md border p-1 transition-colors', active ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:border-brand-300')}
              >
                {p.widths.map((w, i) => (
                  <span key={i} className={cx('rounded-sm', active ? 'bg-brand-400' : 'bg-slate-300')} style={{ flex: w }} />
                ))}
              </button>
            );
          })}
        </div>
      </Prop>
      <Prop label="Espace entre colonnes">
        <RangeInput value={b.gap} placeholder={24} min={0} max={96} onChange={(gap) => set({ gap }, true)} onReset={() => set({ gap: undefined })} />
      </Prop>
      <Prop label="Alignement vertical">
        <Segmented
          value={b.valign ?? 'top'}
          onChange={(valign) => set({ valign })}
          options={[
            { value: 'top', label: 'Haut' },
            { value: 'center', label: 'Centre' },
            { value: 'bottom', label: 'Bas' },
          ]}
        />
      </Prop>
      <Check checked={b.stackOnMobile !== false} onChange={(stackOnMobile) => set({ stackOnMobile })} label="Empiler sur mobile" />
      {b.stackOnMobile !== false && <Check checked={!!b.reverseOnMobile} onChange={(reverseOnMobile) => set({ reverseOnMobile })} label="Inverser l’ordre sur mobile" />}
      <div className="-mx-4 border-t border-slate-100" />
      <p className="text-[13px] font-medium text-slate-800">Colonnes</p>
      {cols.map((c, i) => (
        <div key={c.id} className="space-y-2.5 rounded-lg border border-slate-200 bg-slate-50/60 p-2.5">
          <div className="text-xs font-semibold text-slate-600">
            Colonne {i + 1} · {Math.round(c.width)}% · {c.children?.length ?? 0} bloc{(c.children?.length ?? 0) > 1 ? 's' : ''}
          </div>
          <Prop label="Fond">
            <ColorInput value={c.background} onChange={(background) => set({ columns: cols.map((x, k) => (k === i ? { ...x, background } : x)) }, true)} />
          </Prop>
          <Prop label="Marge intérieure">
            <RangeInput value={c.padding} placeholder={0} min={0} max={80} onChange={(padding) => set({ columns: cols.map((x, k) => (k === i ? { ...x, padding } : x)) }, true)} />
          </Prop>
        </div>
      ))}
    </>
  );
}

/* ---------------- marketing blocks ---------------- */

const toLocalInput = (iso?: string) => {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function CountdownProps({ b, set }: { b: CountdownBlock; set: Setter<CountdownBlock> }) {
  const minutes = b.minutes ?? 60;
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  const setDur = (dd: number, hh: number, mm: number) => set({ minutes: Math.max(1, dd * 1440 + hh * 60 + mm) }, true);
  return (
    <>
      <Prop label="Type">
        <Segmented
          value={b.mode}
          onChange={(mode) => set({ mode, date: mode === 'date' && !b.date ? new Date(Date.now() + 3 * 86400_000).toISOString() : b.date })}
          options={[
            { value: 'date', label: 'Date fixe' },
            { value: 'evergreen', label: 'Evergreen' },
          ]}
        />
      </Prop>
      {b.mode === 'date' ? (
        <Prop label="Date et heure de fin" hint="Heure locale de votre navigateur.">
          <input type="datetime-local" className={inputCls} value={toLocalInput(b.date)} onChange={(e) => e.target.value && set({ date: new Date(e.target.value).toISOString() })} />
        </Prop>
      ) : (
        <Prop label="Durée depuis la première visite" hint="Chaque visiteur a son propre compte à rebours (mémorisé dans son navigateur).">
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                ['Jours', d, (v: number) => setDur(v, h, m)],
                ['Heures', h, (v: number) => setDur(d, v, m)],
                ['Minutes', m, (v: number) => setDur(d, h, v)],
              ] as const
            ).map(([label, v, on]) => (
              <label key={label} className="block">
                <span className="mb-1 block text-[11px] text-slate-500">{label}</span>
                <input type="number" min={0} className={cx(inputCls, 'h-8')} value={v} onChange={(e) => on(Math.max(0, Number(e.target.value) || 0))} />
              </label>
            ))}
          </div>
        </Prop>
      )}
      <Prop label="Texte à la fin du compte à rebours">
        <input className={inputCls} value={b.expiredText ?? ''} placeholder="ex. L’offre est terminée" onChange={(e) => set({ expiredText: e.target.value }, true)} />
      </Prop>
      <Check checked={b.showLabels !== false} onChange={(showLabels) => set({ showLabels })} label="Afficher Jours / Heures / Min / Sec" />
      <Prop label="Fond des cases">
        <ColorInput value={b.boxBg} placeholder="#0f172a" onChange={(boxBg) => set({ boxBg }, true)} />
      </Prop>
      <Prop label="Couleur des chiffres">
        <ColorInput value={b.boxColor} placeholder="#ffffff" onChange={(boxColor) => set({ boxColor }, true)} />
      </Prop>
    </>
  );
}

function TestimonialProps({ b, set, browse }: { b: TestimonialBlock; set: Setter<TestimonialBlock> } & WithMedia) {
  return (
    <>
      <Prop label="Témoignage">
        <RichField value={b.quote} onChange={(quote) => set({ quote }, true)} minHeight={90} primary />
      </Prop>
      <Prop label="Nom">
        <input className={inputCls} value={b.name} onChange={(e) => set({ name: e.target.value }, true)} />
      </Prop>
      <Prop label="Fonction / ville (optionnel)">
        <input className={inputCls} value={b.role ?? ''} onChange={(e) => set({ role: e.target.value }, true)} />
      </Prop>
      <Prop label="Photo">
        <ImageField value={b.photo} compact onChange={(photo) => set({ photo: photo || undefined }, true)} onBrowse={browse((photo) => set({ photo }))} />
      </Prop>
      <Prop label="Étoiles">
        <Segmented value={b.stars ?? 5} onChange={(stars) => set({ stars })} options={[0, 1, 2, 3, 4, 5].map((n) => ({ value: n, label: n ? `${n}★` : '—' }))} />
      </Prop>
      <Prop label="Présentation">
        <Segmented
          value={b.layout ?? 'card'}
          onChange={(layout) => set({ layout })}
          options={[
            { value: 'card', label: 'Carte' },
            { value: 'plain', label: 'Simple' },
          ]}
        />
      </Prop>
      {b.layout !== 'plain' && (
        <Prop label="Fond de la carte">
          <ColorInput value={b.cardBg} placeholder="#ffffff" onChange={(cardBg) => set({ cardBg }, true)} />
        </Prop>
      )}
    </>
  );
}

function PricingProps({ b, set, mode, settings }: { b: PricingBlock; set: Setter<PricingBlock> } & WithMedia) {
  const features = Array.isArray(b.features) ? b.features : [];
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <Prop label="Nom de l’offre">
          <input className={inputCls} value={b.title} onChange={(e) => set({ title: e.target.value }, true)} />
        </Prop>
        <Prop label="Prix">
          <input className={inputCls} value={b.price} onChange={(e) => set({ price: e.target.value }, true)} />
        </Prop>
      </div>
      <Prop label="Période / mention">
        <input className={inputCls} value={b.period ?? ''} placeholder="/ mois, paiement unique…" onChange={(e) => set({ period: e.target.value }, true)} />
      </Prop>
      <Prop label="Description">
        <RichField value={b.description ?? ''} onChange={(description) => set({ description }, true)} singleLine compact />
      </Prop>
      <Prop label={`Avantages (${features.length})`}>
        <ItemsEditor items={features} onChange={(n, merge) => set({ features: n }, merge)} create={() => 'Nouvel avantage'} addLabel="Ajouter un avantage" render={(it, update) => <RichField value={it} onChange={(v) => update(v, true)} singleLine compact />} />
      </Prop>
      <Prop label="Texte du bouton">
        <input className={inputCls} value={b.buttonLabel} onChange={(e) => set({ buttonLabel: e.target.value }, true)} />
      </Prop>
      <ActionFields mode={mode} action={b.action} url={b.url} onAction={(action) => set({ action })} onUrl={(url) => set({ url }, true)} />
      <Check checked={!!b.highlighted} onChange={(highlighted) => set({ highlighted })} label="Mettre en avant cette offre" />
      {b.highlighted && (
        <Prop label="Badge">
          <input className={inputCls} value={b.badge ?? ''} placeholder="Populaire" onChange={(e) => set({ badge: e.target.value }, true)} />
        </Prop>
      )}
      <Prop label="Couleur d’accent">
        <ColorInput value={b.accent} placeholder={settings.accent} onChange={(accent) => set({ accent }, true)} />
      </Prop>
      <Prop label="Fond de la carte">
        <ColorInput value={b.cardBg} placeholder="#ffffff" onChange={(cardBg) => set({ cardBg }, true)} />
      </Prop>
    </>
  );
}

function FaqProps({ b, set }: { b: FaqBlock; set: Setter<FaqBlock> }) {
  const items = Array.isArray(b.items) ? b.items : [];
  return (
    <>
      <ItemsEditor
        items={items}
        onChange={(n, merge) => set({ items: n }, merge)}
        create={() => ({ q: 'Nouvelle question ?', a: 'La réponse à cette question.' })}
        addLabel="Ajouter une question"
        render={(it, update) => (
          <div className="space-y-1.5">
            <input className={cx(inputCls, 'h-8 font-medium')} value={it.q} placeholder="Question" onChange={(e) => update({ ...it, q: e.target.value }, true)} />
            <RichField value={it.a} onChange={(a) => update({ ...it, a }, true)} minHeight={48} compact />
          </div>
        )}
      />
      <Check checked={!!b.openFirst} onChange={(openFirst) => set({ openFirst })} label="Première question ouverte par défaut" />
      <p className="text-[11px] leading-snug text-slate-400">Sur la page, les réponses se déplient au clic. Dans un email, elles sont toutes affichées.</p>
    </>
  );
}

const EMOJIS = ['🚀', '⚡', '🎯', '💡', '✅', '🔒', '📈', '🎁', '💬', '🤝', '⏱️', '🏆', '❤️', '📚', '🛡️', '✨'];

function FeatureProps({ b, set, settings }: { b: FeatureBlock; set: Setter<FeatureBlock>; settings: PageSettings }) {
  return (
    <>
      <Prop label="Icône (emoji)">
        <div className="space-y-2">
          <input className={cx(inputCls, 'w-20 text-center text-lg')} value={b.icon} maxLength={8} onChange={(e) => set({ icon: e.target.value }, true)} />
          <div className="flex flex-wrap gap-1">
            {EMOJIS.map((e) => (
              <button key={e} type="button" onClick={() => set({ icon: e })} className={cx('h-8 w-8 rounded-md text-lg hover:bg-slate-100', b.icon === e && 'bg-brand-50 ring-1 ring-brand-300')}>
                {e}
              </button>
            ))}
          </div>
        </div>
      </Prop>
      <Prop label="Titre">
        <input className={inputCls} value={b.title} onChange={(e) => set({ title: e.target.value }, true)} data-primary-field="" />
      </Prop>
      <Prop label="Texte">
        <RichField value={b.text} onChange={(text) => set({ text }, true)} minHeight={60} compact />
      </Prop>
      <Prop label="Disposition">
        <Segmented
          value={b.layout ?? 'top'}
          onChange={(layout) => set({ layout })}
          options={[
            { value: 'top', label: 'Icône au-dessus' },
            { value: 'left', label: 'Icône à gauche' },
          ]}
        />
      </Prop>
      <Prop label="Fond de l’icône">
        <ColorInput value={b.iconBg} placeholder={`${settings.accent}1a`} onChange={(iconBg) => set({ iconBg }, true)} />
      </Prop>
      <Prop label="Taille de l’icône">
        <RangeInput value={b.iconSize} placeholder={56} min={24} max={120} onChange={(iconSize) => set({ iconSize }, true)} onReset={() => set({ iconSize: undefined })} />
      </Prop>
    </>
  );
}

function SocialProps({ b, set }: { b: SocialBlock; set: Setter<SocialBlock> }) {
  const links = Array.isArray(b.links) ? b.links : [];
  return (
    <>
      <ItemsEditor
        items={links}
        min={0}
        onChange={(n, merge) => set({ links: n }, merge)}
        create={() => ({ network: 'website' as SocialNetwork, url: 'https://' })}
        addLabel="Ajouter un réseau"
        render={(it, update) => (
          <div className="space-y-1.5">
            <select className={cx(inputCls, 'h-8')} value={it.network} onChange={(e) => update({ ...it, network: e.target.value as SocialNetwork })}>
              {(Object.keys(SOCIAL_NETWORKS) as SocialNetwork[]).map((n) => (
                <option key={n} value={n}>
                  {SOCIAL_NETWORKS[n].label}
                </option>
              ))}
            </select>
            <input className={cx(inputCls, 'h-8')} value={it.url} placeholder={it.network === 'email' ? 'contact@exemple.fr' : 'https://…'} onChange={(e) => update({ ...it, url: e.target.value }, true)} />
          </div>
        )}
      />
      <Prop label="Style">
        <select className={inputCls} value={b.variant ?? 'brand'} onChange={(e) => set({ variant: e.target.value as SocialBlock['variant'] })}>
          <option value="brand">Couleurs des marques</option>
          <option value="accent">Couleur principale</option>
          <option value="dark">Sombre</option>
          <option value="outline">Contour</option>
        </select>
      </Prop>
      <Prop label="Taille">
        <RangeInput value={b.size} placeholder={40} min={24} max={72} onChange={(size) => set({ size }, true)} />
      </Prop>
    </>
  );
}

function ImageTextProps({ b, set, mode, browse }: { b: ImageTextBlock; set: Setter<ImageTextBlock> } & WithMedia) {
  return (
    <>
      <Prop label="Image">
        <ImageField value={b.src} compact onChange={(src) => set({ src }, true)} onBrowse={browse((src) => set({ src }))} />
      </Prop>
      <Prop label="Position de l’image">
        <Segmented
          value={b.imagePosition}
          onChange={(imagePosition) => set({ imagePosition })}
          options={[
            { value: 'left', label: 'À gauche' },
            { value: 'right', label: 'À droite' },
          ]}
        />
      </Prop>
      <Prop label="Largeur de l’image">
        <RangeInput value={b.imageWidth ?? 45} min={20} max={70} unit="%" onChange={(imageWidth) => set({ imageWidth }, true)} />
      </Prop>
      <Prop label="Arrondi de l’image">
        <RangeInput value={b.radius} placeholder={14} min={0} max={300} onChange={(radius) => set({ radius }, true)} />
      </Prop>
      <Prop label="Titre">
        <input className={inputCls} value={b.title ?? ''} onChange={(e) => set({ title: e.target.value }, true)} />
      </Prop>
      <Prop label="Texte">
        <RichField value={b.text} onChange={(text) => set({ text }, true)} minHeight={90} />
      </Prop>
      <Prop label="Bouton (optionnel)">
        <input className={inputCls} value={b.buttonLabel ?? ''} placeholder="Texte du bouton" onChange={(e) => set({ buttonLabel: e.target.value || undefined }, true)} />
      </Prop>
      {b.buttonLabel && <ActionFields mode={mode} action={b.buttonAction} url={b.buttonUrl} onAction={(buttonAction) => set({ buttonAction })} onUrl={(buttonUrl) => set({ buttonUrl }, true)} />}
      <Prop label="Texte alternatif de l’image">
        <input className={inputCls} value={b.alt ?? ''} onChange={(e) => set({ alt: e.target.value }, true)} />
      </Prop>
    </>
  );
}

function ProgressProps({ b, set, settings }: { b: ProgressBlock; set: Setter<ProgressBlock>; settings: PageSettings }) {
  return (
    <>
      <Prop label="Libellé">
        <input className={inputCls} value={b.label ?? ''} placeholder="ex. Places réservées" onChange={(e) => set({ label: e.target.value }, true)} />
      </Prop>
      <Prop label="Valeur">
        <RangeInput value={b.value} min={0} max={100} unit="%" onChange={(value) => set({ value }, true)} />
      </Prop>
      <Prop label="Couleur de la barre">
        <ColorInput value={b.barColor} placeholder={settings.accent} onChange={(barColor) => set({ barColor }, true)} />
      </Prop>
      <Prop label="Couleur du fond">
        <ColorInput value={b.trackColor} placeholder="#e2e8f0" onChange={(trackColor) => set({ trackColor }, true)} />
      </Prop>
      <Prop label="Épaisseur">
        <RangeInput value={b.height} placeholder={14} min={4} max={40} onChange={(height) => set({ height }, true)} />
      </Prop>
      <Check checked={!!b.striped} onChange={(striped) => set({ striped })} label="Rayures" />
    </>
  );
}

function LinksEditor({ links, onChange }: { links: { label: string; url: string }[]; onChange: (l: { label: string; url: string }[], merge?: boolean) => void }) {
  return (
    <ItemsEditor
      items={links}
      min={0}
      onChange={onChange}
      create={() => ({ label: 'Lien', url: '#' })}
      addLabel="Ajouter un lien"
      render={(it, update) => (
        <div className="grid grid-cols-2 gap-1.5">
          <input className={cx(inputCls, 'h-8')} value={it.label} placeholder="Texte" onChange={(e) => update({ ...it, label: e.target.value }, true)} />
          <input className={cx(inputCls, 'h-8')} value={it.url} placeholder="https://… ou #ancre" onChange={(e) => update({ ...it, url: e.target.value }, true)} />
        </div>
      )}
    />
  );
}

function NavbarProps({ b, set, mode, browse }: { b: NavbarBlock; set: Setter<NavbarBlock> } & WithMedia) {
  return (
    <>
      <Prop label="Logo (image)">
        <ImageField value={b.logoSrc} compact onChange={(logoSrc) => set({ logoSrc: logoSrc || undefined }, true)} onBrowse={browse((logoSrc) => set({ logoSrc }))} />
      </Prop>
      {b.logoSrc ? (
        <Prop label="Largeur du logo">
          <RangeInput value={b.logoWidth} placeholder={140} min={30} max={400} onChange={(logoWidth) => set({ logoWidth }, true)} />
        </Prop>
      ) : (
        <Prop label="Nom affiché (sans image)">
          <input className={inputCls} value={b.logoText ?? ''} onChange={(e) => set({ logoText: e.target.value }, true)} />
        </Prop>
      )}
      <Prop label="Liens">
        <LinksEditor links={Array.isArray(b.links) ? b.links : []} onChange={(links, merge) => set({ links }, merge)} />
      </Prop>
      {mode === 'page' && (
        <>
          <Prop label="Bouton (optionnel)">
            <input className={inputCls} value={b.ctaLabel ?? ''} placeholder="Texte du bouton" onChange={(e) => set({ ctaLabel: e.target.value || undefined }, true)} />
          </Prop>
          {b.ctaLabel && (
            <Prop label="Lien du bouton">
              <input className={inputCls} value={b.ctaUrl ?? ''} placeholder="https://… ou #ancre" onChange={(e) => set({ ctaUrl: e.target.value }, true)} />
            </Prop>
          )}
          <Check checked={!!b.sticky} onChange={(sticky) => set({ sticky })} label="Rester visible au défilement" />
          <p className="text-[11px] leading-snug text-slate-400">Sur mobile, les liens sont masqués ; le logo et le bouton restent visibles.</p>
        </>
      )}
    </>
  );
}

function FooterProps({ b, set }: { b: FooterBlock; set: Setter<FooterBlock> }) {
  return (
    <>
      <Prop label="Texte">
        <RichField value={b.text} onChange={(text) => set({ text }, true)} minHeight={60} compact />
      </Prop>
      <Prop label="Liens">
        <LinksEditor links={Array.isArray(b.links) ? b.links : []} onChange={(links, merge) => set({ links }, merge)} />
      </Prop>
      <Prop label="Copyright">
        <input className={inputCls} value={b.copyright ?? ''} onChange={(e) => set({ copyright: e.target.value }, true)} />
      </Prop>
    </>
  );
}

function HtmlProps({ b, set, mode }: { b: HtmlBlock; set: Setter<HtmlBlock>; mode: BuilderMode }) {
  return (
    <>
      {mode === 'email' && <p className="text-xs text-amber-700">Le HTML personnalisé n’est pas pris en charge dans les emails.</p>}
      <Prop
        label="Code HTML"
        hint="Inséré tel quel sur la page publique (widgets, scripts, iframes). Dans l’éditeur, il est affiché dans un aperçu isolé, sans exécuter de script."
      >
        <textarea
          className={cx(textareaCls, 'min-h-[220px] font-mono text-xs leading-relaxed')}
          value={b.html}
          spellCheck={false}
          placeholder={'<div>…</div>\n<script>…</script>'}
          onChange={(e) => set({ html: e.target.value }, true)}
          data-primary-field=""
        />
      </Prop>
    </>
  );
}

function RatingProps({ b, set }: { b: RatingBlock; set: Setter<RatingBlock> }) {
  return (
    <>
      <Prop label="Note">
        <RangeInput value={b.value} min={0} max={b.max ?? 5} step={0.5} unit="★" onChange={(value) => set({ value }, true)} />
      </Prop>
      <Prop label="Nombre d’étoiles">
        <Segmented value={b.max ?? 5} onChange={(max) => set({ max, value: Math.min(b.value, max) })} options={[3, 5, 10].map((n) => ({ value: n, label: String(n) }))} />
      </Prop>
      <Prop label="Taille">
        <RangeInput value={b.size} placeholder={26} min={12} max={64} onChange={(size) => set({ size }, true)} />
      </Prop>
      <Prop label="Couleur">
        <ColorInput value={b.starColor} placeholder="#f59e0b" onChange={(starColor) => set({ starColor }, true)} />
      </Prop>
      <Prop label="Légende">
        <input className={inputCls} value={b.caption ?? ''} placeholder="4,9/5 sur 320 avis" onChange={(e) => set({ caption: e.target.value }, true)} />
      </Prop>
    </>
  );
}

function QuoteProps({ b, set, settings }: { b: QuoteBlock; set: Setter<QuoteBlock>; settings: PageSettings }) {
  return (
    <>
      <Prop label="Citation">
        <RichField value={b.text} onChange={(text) => set({ text }, true)} minHeight={80} primary />
      </Prop>
      <Prop label="Auteur">
        <input className={inputCls} value={b.author ?? ''} onChange={(e) => set({ author: e.target.value }, true)} />
      </Prop>
      <Prop label="Couleur de la barre">
        <ColorInput value={b.barColor} placeholder={settings.accent} onChange={(barColor) => set({ barColor }, true)} />
      </Prop>
    </>
  );
}

/* ---------------- style tab ---------------- */

const DEFAULT_FONT: Partial<Record<BlockType, number>> = { text: 17, list: 17, button: 18, quote: 22, footer: 14, testimonial: 18, faq: 18, feature: 19, imageText: 17, countdown: 34 };
const LEAF_PY: Partial<Record<BlockType, number>> = { section: 56, columns: 8 };

function StyleTab({ block, settings, setStyle, mode }: { block: Block; settings: PageSettings; setStyle: (p: Partial<BlockStyle>, merge?: boolean) => void; mode: BuilderMode }) {
  const s = block.style ?? {};
  const t = block.type;
  const hasAlign = !['spacer', 'faq', 'html', 'progress', 'navbar', 'imageText', 'columns'].includes(t);
  const fullTypo = TEXT_TYPES.includes(t);
  const sizeOnly = ['button', 'testimonial', 'faq', 'feature', 'imageText', 'countdown'].includes(t);
  const hasMobileSize = t === 'heading' || t === 'text';
  const fontDefault = t === 'heading' ? ({ 1: 40, 2: 30, 3: 22 } as const)[(block as HeadingBlock).level] ?? 30 : DEFAULT_FONT[t];
  const py = s.paddingY ?? LEAF_PY[t] ?? 12;
  const px = t === 'section' ? 24 : 24;

  const hasAdvancedTypo = fullTypo;
  return (
    <>
      {hasAlign && (
        <div className="border-b border-slate-100 px-4 py-3.5">
          <Prop label="Alignement" inline>
            <Segmented
              full={false}
              value={s.align ?? (t === 'feature' ? 'center' : 'left')}
              onChange={(align) => setStyle({ align })}
              options={[
                { value: 'left', icon: TextAlignStart, title: 'À gauche' },
                { value: 'center', icon: TextAlignCenter, title: 'Centré' },
                { value: 'right', icon: TextAlignEnd, title: 'À droite' },
              ]}
            />
          </Prop>
        </div>
      )}
      {(fullTypo || sizeOnly) && (
        <Group title="Typographie" id="style-typo" defaultOpen>
          <Prop label="Taille du texte">
            <RangeInput value={s.fontSize} placeholder={fontDefault} min={10} max={96} onChange={(fontSize) => setStyle({ fontSize }, true)} onReset={() => setStyle({ fontSize: undefined })} />
          </Prop>
          {hasMobileSize && (
            <Prop label="Taille sur mobile" hint="Appliquée sous 640 px de large.">
              <RangeInput value={s.mobileFontSize} placeholder={s.fontSize ?? fontDefault} min={10} max={72} onChange={(mobileFontSize) => setStyle({ mobileFontSize }, true)} onReset={() => setStyle({ mobileFontSize: undefined })} />
            </Prop>
          )}
          {(fullTypo || t === 'button') && (
            <Prop label="Graisse">
              <select className={inputCls} value={s.fontWeight ?? ''} onChange={(e) => setStyle({ fontWeight: e.target.value ? Number(e.target.value) : undefined })}>
                <option value="">Par défaut</option>
                <option value="300">Light (300)</option>
                <option value="400">Normal (400)</option>
                <option value="500">Medium (500)</option>
                <option value="600">Semi-bold (600)</option>
                <option value="700">Bold (700)</option>
                <option value="800">Extra-bold (800)</option>
                <option value="900">Black (900)</option>
              </select>
            </Prop>
          )}
        </Group>
      )}
      <Group title="Couleurs" id="style-colors" defaultOpen={!(fullTypo || sizeOnly)}>
        {t !== 'spacer' && t !== 'divider' && (
          <Prop label="Couleur du texte">
            <ColorInput value={s.color} placeholder={settings.textColor} onChange={(color) => setStyle({ color }, true)} />
          </Prop>
        )}
        <Prop label="Couleur de fond">
          <ColorInput value={s.background} onChange={(background) => setStyle({ background }, true)} />
        </Prop>
      </Group>
      {t !== 'spacer' && (
        <Group title="Espacement" id="style-spacing">
          <Prop label="Marge intérieure (padding)">
            <NumberPair
              labels={['Haut', 'Bas']}
              values={[s.paddingTop, s.paddingBottom]}
              placeholders={[py, py]}
              onChange={(i, v) => setStyle(i === 0 ? { paddingTop: v } : { paddingBottom: v }, true)}
            />
          </Prop>
          <Prop label="Marge intérieure latérale">
            <RangeInput value={s.paddingX} placeholder={px} min={0} max={120} onChange={(paddingX) => setStyle({ paddingX }, true)} onReset={() => setStyle({ paddingX: undefined })} />
          </Prop>
        </Group>
      )}
      <Group title="Avancé" id="style-advanced" defaultOpen={!!(s.borderWidth || s.borderRadius || s.shadow || s.hideOnMobile || s.hideOnDesktop)}>
        {hasAdvancedTypo && (
          <>
            <Prop label="Hauteur de ligne">
              <RangeInput value={s.lineHeight} placeholder={t === 'heading' ? 1.2 : 1.6} min={0.8} max={2.6} step={0.05} unit="" onChange={(lineHeight) => setStyle({ lineHeight }, true)} onReset={() => setStyle({ lineHeight: undefined })} />
            </Prop>
            <Prop label="Espacement des lettres">
              <RangeInput value={s.letterSpacing} placeholder={0} min={-5} max={20} step={0.5} onChange={(letterSpacing) => setStyle({ letterSpacing }, true)} onReset={() => setStyle({ letterSpacing: undefined })} />
            </Prop>
          </>
        )}
        {t !== 'spacer' && (
          <Prop label="Marge extérieure (margin)">
            <NumberPair labels={['Haut', 'Bas']} values={[s.marginTop, s.marginBottom]} placeholders={[0, 0]} min={-120} onChange={(i, v) => setStyle(i === 0 ? { marginTop: v } : { marginBottom: v }, true)} />
          </Prop>
        )}
        <Prop label="Épaisseur de bordure">
          <RangeInput value={s.borderWidth} placeholder={0} min={0} max={12} onChange={(borderWidth) => setStyle({ borderWidth: borderWidth || undefined }, true)} onReset={() => setStyle({ borderWidth: undefined })} />
        </Prop>
        {!!s.borderWidth && (
          <Prop label="Couleur de bordure">
            <ColorInput value={s.borderColor} placeholder="#e2e8f0" onChange={(borderColor) => setStyle({ borderColor }, true)} />
          </Prop>
        )}
        <Prop label="Arrondi">
          <RangeInput value={s.borderRadius} placeholder={0} min={0} max={60} onChange={(borderRadius) => setStyle({ borderRadius: borderRadius || undefined }, true)} onReset={() => setStyle({ borderRadius: undefined })} />
        </Prop>
        {mode === 'page' && (
          <Prop label="Ombre">
            <div className="grid grid-cols-5 gap-1.5">
              {(Object.keys(SHADOWS) as (keyof typeof SHADOWS)[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  title={k === 'none' ? 'Aucune' : k.toUpperCase()}
                  onClick={() => setStyle({ shadow: k === 'none' ? undefined : (k as BlockStyle['shadow']) })}
                  className={cx('flex h-9 items-center justify-center rounded-lg border bg-white text-[10px] font-semibold text-slate-500', (s.shadow ?? 'none') === k ? 'border-brand-500 ring-2 ring-brand-500/20' : 'border-slate-200')}
                >
                  <span className="h-4 w-5 rounded bg-white" style={{ boxShadow: SHADOWS[k] ?? 'inset 0 0 0 1px #e2e8f0' }} />
                </button>
              ))}
            </div>
          </Prop>
        )}
        <Prop label="Visibilité" hint="Dans l’éditeur, les blocs masqués pour l’appareil affiché apparaissent en transparence.">
          <div className="space-y-2">
            <Check checked={!!s.hideOnMobile} onChange={(hideOnMobile) => setStyle({ hideOnMobile: hideOnMobile || undefined, hideOnDesktop: hideOnMobile ? undefined : s.hideOnDesktop })} label="Masquer sur mobile" />
            <Check checked={!!s.hideOnDesktop} onChange={(hideOnDesktop) => setStyle({ hideOnDesktop: hideOnDesktop || undefined, hideOnMobile: hideOnDesktop ? undefined : s.hideOnMobile })} label="Masquer sur ordinateur" />
          </div>
        </Prop>
      </Group>
    </>
  );
}

/* ---------------- page / email settings ---------------- */

export function SettingsPanel({ mode, settings }: { mode: BuilderMode; settings: PageSettings }) {
  const { ops, openMedia } = useBuilder();
  const set = (patch: Partial<PageSettings>, merge?: boolean) => ops.updateSettings(patch, merge ? `settings:${Object.keys(patch).join(',')}` : undefined);
  const isEmail = mode === 'email';
  const fonts = fontOptions(GOOGLE_FONTS, mode);
  const groups = [...new Set(fonts.map((f) => f.group))];
  const FontSelect = ({ value, onChange, allowInherit }: { value: string | undefined; onChange: (v: string | undefined) => void; allowInherit?: boolean }) => (
    <select className={inputCls} value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)} style={{ fontFamily: value }}>
      {allowInherit && <option value="">Identique au texte</option>}
      {value && !fonts.some((f) => f.value === value) && <option value={value}>{fontLabel(value)}</option>}
      {groups.map((g) => (
        <optgroup key={g} label={g}>
          {fonts
            .filter((f) => f.group === g)
            .map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );

  return (
    <>
      <div className="scalo-scroll flex-1 overflow-y-auto border-t border-slate-100">
        <Group title="Couleurs" id="settings-colors" defaultOpen>
          <Prop label={isEmail ? 'Fond de l’email' : 'Fond de la page'}>
            <ColorInput value={settings.background} allowClear={false} onChange={(v) => v && set({ background: v }, true)} />
          </Prop>
          <Prop label="Fond du contenu">
            <ColorInput value={settings.contentBackground} allowClear={false} onChange={(v) => v && set({ contentBackground: v }, true)} />
          </Prop>
          <Prop label="Couleur du texte">
            <ColorInput value={settings.textColor} allowClear={false} onChange={(v) => v && set({ textColor: v }, true)} />
          </Prop>
          <Prop label="Couleur principale" hint="Boutons, liens, puces et accents.">
            <ColorInput value={settings.accent} allowClear={false} onChange={(v) => v && set({ accent: v }, true)} />
          </Prop>
        </Group>
        <Group title="Typographie" id="settings-typo">
          <Prop label="Police du texte" hint={isEmail ? 'Polices compatibles avec toutes les messageries.' : 'Les Google Fonts sont chargées automatiquement sur la page publique.'}>
            <FontSelect value={settings.fontFamily} onChange={(v) => v && set({ fontFamily: v })} />
          </Prop>
          <Prop label="Police des titres">
            <FontSelect value={settings.headingFont} onChange={(headingFont) => set({ headingFont })} allowInherit />
          </Prop>
        </Group>
        <Group title="Mise en page" id="settings-layout">
          <Prop label="Largeur du contenu">
            <RangeInput value={settings.maxWidth} min={isEmail ? 320 : 360} max={isEmail ? 800 : 1400} step={10} onChange={(maxWidth) => set({ maxWidth }, true)} />
          </Prop>
          <Prop label="Marge verticale de la page">
            <RangeInput value={settings.contentPadding} placeholder={isEmail ? 16 : 24} min={0} max={120} onChange={(contentPadding) => set({ contentPadding }, true)} onReset={() => set({ contentPadding: undefined })} />
          </Prop>
        </Group>
        {!isEmail && (
          <>
            <Group title="SEO & partage" id="settings-seo">
              <Prop label="Titre de la page (onglet, Google)" hint="60 caractères recommandés. Vide = nom de l’étape." aside={`${(settings.seoTitle ?? '').length}/60`}>
                <input className={inputCls} value={settings.seoTitle ?? ''} maxLength={120} onChange={(e) => set({ seoTitle: e.target.value || undefined }, true)} />
              </Prop>
              <Prop label="Description" hint="160 caractères recommandés." aside={`${(settings.seoDescription ?? '').length}/160`}>
                <textarea className={cx(textareaCls, 'min-h-[70px]')} maxLength={300} value={settings.seoDescription ?? ''} onChange={(e) => set({ seoDescription: e.target.value || undefined }, true)} />
              </Prop>
              <Prop label="Image de partage (réseaux sociaux)" hint="Idéalement 1200 × 630 px.">
                <ImageField value={settings.ogImage} compact onChange={(ogImage) => set({ ogImage: ogImage || undefined }, true)} onBrowse={() => openMedia((ogImage) => set({ ogImage }))} />
              </Prop>
              <Prop label="Favicon" hint="Icône carrée affichée dans l’onglet du navigateur.">
                <ImageField value={settings.favicon} compact onChange={(favicon) => set({ favicon: favicon || undefined }, true)} onBrowse={() => openMedia((favicon) => set({ favicon }))} />
              </Prop>
            </Group>
            <Group title="Code de suivi" id="settings-head" defaultOpen={!!settings.headCode}>
              <Prop label="Code ajouté dans <head>" hint="Pixel Facebook, Google Analytics, Tag Manager… Exécuté uniquement sur la page publique.">
                <textarea
                  className={cx(textareaCls, 'min-h-[120px] font-mono text-xs')}
                  spellCheck={false}
                  value={settings.headCode ?? ''}
                  placeholder={'<script>…</script>'}
                  onChange={(e) => set({ headCode: e.target.value || undefined }, true)}
                />
              </Prop>
            </Group>
          </>
        )}
        <Group title="Personnalisation" id="settings-vars">
          <p className="text-xs leading-relaxed text-slate-500">
            Utilisez <code className="rounded bg-slate-100 px-1 text-slate-700">{'{{first_name}}'}</code>, <code className="rounded bg-slate-100 px-1 text-slate-700">{'{{last_name}}'}</code>,{' '}
            <code className="rounded bg-slate-100 px-1 text-slate-700">{'{{email}}'}</code> dans vos textes (bouton « Variable » de la barre de mise en forme) : ils sont remplacés par les informations du contact
            {isEmail ? '.' : ' (s’il s’est déjà inscrit).'}
          </p>
          {isEmail && <p className="text-xs leading-relaxed text-slate-500">L’adresse de votre entreprise et le lien de désinscription sont ajoutés automatiquement en pied d’email.</p>}
        </Group>
      </div>
    </>
  );
}

/** Preheader of an email (text shown after the subject in inboxes). Must be rendered inside the builder. */
export function PreheaderField({ value }: { value: string | undefined }) {
  const { ops } = useBuilder();
  return (
    <Prop label="Texte d’aperçu (preheader)" hint="Affiché après l’objet dans la plupart des messageries." aside={`${(value ?? '').length}/140`}>
      <textarea
        className={cx(textareaCls, 'min-h-[64px]')}
        maxLength={200}
        value={value ?? ''}
        placeholder="ex. Votre cadeau vous attend à l’intérieur 🎁"
        onChange={(e) => ops.updateSettings({ preheader: e.target.value || undefined }, 'settings:preheader')}
      />
    </Prop>
  );
}

/* ---------------- small helpers ---------------- */

function MiniBtn({ children, title, onClick, disabled, danger }: { children: ReactNode; title: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'flex h-6 w-6 items-center justify-center rounded-md text-slate-400 transition-colors disabled:opacity-30 disabled:hover:bg-transparent',
        danger ? 'hover:bg-rose-50 hover:text-rose-600' : 'hover:bg-slate-100 hover:text-slate-700',
      )}
    >
      {children}
    </button>
  );
}

function AddRow({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-300 py-1.5 text-xs font-medium text-slate-500 transition-colors hover:border-brand-400 hover:bg-brand-50 hover:text-brand-700"
    >
      <Plus size={14} /> {children}
    </button>
  );
}
