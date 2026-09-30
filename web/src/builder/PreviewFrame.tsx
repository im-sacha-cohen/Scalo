import { useMemo } from 'react';
import { renderEmailDocument, renderPageDocument, type PageContent } from '@scalo/shared';
import { cx } from '../components/ui';
import { DEVICE_WIDTHS, type BuilderMode, type Device } from './context';

const EXAMPLE_VARS = { first_name: 'Marie', last_name: 'Dupont', email: 'marie.dupont@exemple.fr', phone: '06 12 34 56 78' };
// Links and forms are inert in the preview (the frame is sandboxed without forms / top navigation).
const NO_NAV = `<script>document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a');if(a){e.preventDefault()}},true)</script>`;

/**
 * Exact rendering of the published document (public page or email) in a sandboxed iframe:
 * same HTML, same media queries (the iframe width drives them).
 */
export function PreviewFrame({ content, mode, device, title }: { content: PageContent; mode: BuilderMode; device: Device; title: string }) {
  const html = useMemo(() => {
    if (mode === 'email') return renderEmailDocument(content, { subject: title, vars: EXAMPLE_VARS, baseUrl: window.location.origin }).replace('</body>', `${NO_NAV}</body>`);
    return renderPageDocument(content, { title, nextUrl: '#', formAction: '#', vars: EXAMPLE_VARS, headExtra: NO_NAV, baseUrl: window.location.origin });
  }, [content, mode, title]);
  const width = DEVICE_WIDTHS[device];
  return (
    <div className="scalo-scroll flex flex-1 justify-center overflow-auto bg-slate-200/70">
      <div className={cx('my-0 h-full shrink-0', !!width && 'my-6 h-[calc(100%-48px)] overflow-hidden rounded-[30px] border-[10px] border-slate-800 bg-slate-800 shadow-2xl')} style={{ width: width ? width + 20 : '100%' }}>
        <iframe title="Aperçu" sandbox="allow-scripts" srcDoc={html} className={cx('h-full w-full border-0 bg-white', !!width && 'rounded-[20px]')} />
      </div>
    </div>
  );
}
