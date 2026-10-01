import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  FlaskConical,
  Globe,
  GripVertical,
  LayoutTemplate,
  Mail,
  MailCheck,
  Menu,
  Plus,
  Split,
  Tag,
  Upload,
  Webhook,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { cx } from '../../components/ui';
import { ACCOUNT_DELETED_FLAG } from '../../lib/account-api';
import { Logo, LogoMark } from '../../components/Layout';

/* Public marketing page (English: Scalo targets an international audience). Brand rules: brand/BRAND.md —
   flat fills, ink for dark areas, lime only on dark backgrounds, the logo's stepped pills as the recurring motif. */

/** Adds `is-visible` once the element scrolls into view (CSS in index.css handles the transition). */
function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!('IntersectionObserver' in window)) return void el.classList.add('is-visible');
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          el.classList.add('is-visible');
          io.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return ref;
}

function Reveal({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const ref = useReveal<HTMLDivElement>();
  return (
    <div ref={ref} className={cx('landing-reveal', className)} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

function PrimaryCta({ children, to, dark = false }: { children: ReactNode; to: string; dark?: boolean }) {
  return (
    <Link
      to={to}
      className={cx(
        'group inline-flex items-center gap-2 rounded-full px-6 py-3 text-[15px] font-semibold transition-transform active:scale-[0.98]',
        dark ? 'bg-lime-400 text-ink hover:bg-[#d4fa5c]' : 'bg-brand-500 text-white hover:bg-brand-600',
      )}
    >
      {children}
      <ArrowRight size={17} className="transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

// ---------------------------------------------------------------- nav

function Nav() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 24);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  const links = [
    ['#product', 'Product'],
    ['#how', 'How it works'],
    ['#pricing', 'Pricing'],
    ['#faq', 'FAQ'],
  ];
  return (
    <header className={cx('fixed inset-x-0 top-0 z-50 transition-colors', scrolled || open ? 'bg-ink/95 backdrop-blur' : 'bg-transparent')}>
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
        <a href="#top" aria-label="Scalo home">
          <Logo dark />
        </a>
        <nav className="hidden items-center gap-8 md:flex">
          {links.map(([href, label]) => (
            <a key={href} href={href} className="text-sm font-medium text-brand-200 transition-colors hover:text-white">
              {label}
            </a>
          ))}
        </nav>
        <div className="hidden items-center gap-3 md:flex">
          {user ? (
            <PrimaryCta to="/dashboard" dark>
              Open app
            </PrimaryCta>
          ) : (
            <>
              <Link to="/login" className="px-3 text-sm font-medium text-brand-100 hover:text-white">
                Log in
              </Link>
              <Link to="/register" className="rounded-full bg-lime-400 px-4 py-2 text-sm font-semibold text-ink hover:bg-[#d4fa5c]">
                Start free
              </Link>
            </>
          )}
        </div>
        <button className="rounded-lg p-2 text-white md:hidden" onClick={() => setOpen((o) => !o)} aria-label={open ? 'Close menu' : 'Open menu'}>
          {open ? <X size={22} /> : <Menu size={22} />}
        </button>
      </div>
      {open && (
        <div className="border-t border-white/10 px-5 pb-6 md:hidden">
          {links.map(([href, label]) => (
            <a key={href} href={href} onClick={() => setOpen(false)} className="block py-3 text-base font-medium text-brand-100">
              {label}
            </a>
          ))}
          <div className="mt-3 flex gap-3">
            <Link to="/login" className="flex-1 rounded-full border border-white/20 py-2.5 text-center text-sm font-semibold text-white">
              Log in
            </Link>
            <Link to="/register" className="flex-1 rounded-full bg-lime-400 py-2.5 text-center text-sm font-semibold text-ink">
              Start free
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}

// ---------------------------------------------------------------- hero

/** The logo, exploded: visitor → lead → customer, climbing the steps. */
function HeroStairs() {
  const steps = [
    { label: 'Visitor', sub: 'lands on your page', cls: 'bg-brand-800 text-brand-100', left: '0%', top: '64%' },
    { label: 'Lead', sub: 'joins your list', cls: 'bg-brand-500 text-white', left: '16%', top: '38%' },
    { label: 'Customer', sub: 'buys again', cls: 'bg-lime-400 text-ink', left: '32%', top: '12%' },
  ];
  return (
    <div className="relative mx-auto aspect-[5/4] w-full max-w-[560px]" aria-hidden="true">
      {steps.map((s, i) => (
        <div
          key={s.label}
          className={cx('landing-rise absolute flex h-[22%] w-[68%] items-center justify-between rounded-full px-[6%]', s.cls)}
          style={{ left: s.left, top: s.top, animationDelay: `${250 + i * 180}ms` }}
        >
          <span className="font-display text-[clamp(20px,3.2vw,34px)] leading-none font-extrabold tracking-[-0.03em]">{s.label}</span>
          <span className="hidden text-[13px] font-medium whitespace-nowrap opacity-75 sm:block">{s.sub}</span>
        </div>
      ))}
      {/* floating UI chips — an illustration of the product, not real figures */}
      <div className="landing-float absolute top-[2%] left-[2%] flex items-center gap-2 rounded-2xl bg-white px-3.5 py-2.5 shadow-pop" style={{ animationDelay: '900ms' }}>
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-50 text-brand-600">
          <Plus size={15} strokeWidth={2.5} />
        </span>
        <span className="text-[13px] leading-tight">
          <b className="block font-semibold text-ink">New lead</b>
          <span className="text-slate-500">tagged “webinar”</span>
        </span>
      </div>
      <div className="landing-float absolute right-[0%] bottom-[2%] flex items-center gap-2 rounded-2xl bg-white px-3.5 py-2.5 shadow-pop" style={{ animationDelay: '1150ms' }}>
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
          <MailCheck size={15} strokeWidth={2.2} />
        </span>
        <span className="text-[13px] leading-tight">
          <b className="block font-semibold text-ink">Welcome email sent</b>
          <span className="text-slate-500">automatically, 2 min ago</span>
        </span>
      </div>
    </div>
  );
}

function Hero() {
  const { user } = useAuth();
  return (
    <section id="top" className="relative overflow-hidden bg-ink pt-32 pb-20 text-white sm:pt-40 sm:pb-28">
      <div className="mx-auto grid max-w-6xl items-center gap-14 px-5 sm:px-8 lg:grid-cols-[1.05fr_1fr]">
        <div>
          <p className="landing-rise inline-flex items-center gap-2 rounded-full border border-white/15 px-3 py-1 text-[13px] font-medium text-brand-200">
            <span className="h-1.5 w-1.5 rounded-full bg-lime-400" /> The all-in-one tool for creators and small businesses
          </p>
          <h1 className="landing-rise mt-6 font-display text-[clamp(44px,7vw,80px)] leading-[0.98] font-extrabold tracking-[-0.045em]" style={{ animationDelay: '80ms' }}>
            Funnels, emails,
            <br />
            contacts.
            <br />
            <span className="text-lime-400">Built to scale.</span>
          </h1>
          <p className="landing-rise mt-6 max-w-lg text-lg leading-relaxed text-brand-200" style={{ animationDelay: '160ms' }}>
            Build pages that capture leads, send the emails that turn them into customers, and keep every contact in one place.
            One login, one bill, zero duct tape.
          </p>
          <div className="landing-rise mt-9 flex flex-wrap items-center gap-4" style={{ animationDelay: '240ms' }}>
            <PrimaryCta to={user ? '/dashboard' : '/register'} dark>
              {user ? 'Open your dashboard' : 'Start free'}
            </PrimaryCta>
            <a href="#how" className="inline-flex items-center gap-1.5 px-2 text-[15px] font-semibold text-white/90 hover:text-white">
              See how it works <ArrowUpRight size={16} />
            </a>
          </div>
          <p className="landing-rise mt-5 text-[13px] text-brand-300" style={{ animationDelay: '300ms' }}>
            Free plan · No credit card required
          </p>
        </div>
        <HeroStairs />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- stack

function Stack() {
  const tools = [
    ['Page builder', '$49'],
    ['Email marketing', '$39'],
    ['CRM', '$29'],
    ['Automation glue', '$29'],
  ];
  return (
    <section className="border-b border-slate-200 bg-brand-50 py-16 sm:py-20">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <Reveal className="grid items-center gap-10 lg:grid-cols-[1fr_auto_1fr]">
          <div>
            <p className="text-sm font-semibold text-brand-600">The usual stack</p>
            <ul className="mt-4 space-y-2.5">
              {tools.map(([name, price]) => (
                <li key={name} className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 text-slate-500">
                  <span className="line-through decoration-slate-300">{name}</span>
                  <span className="font-mono text-sm">{price}/mo</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-right font-mono text-sm text-slate-500">
              = <span className="line-through">$146/mo</span> and four logins
            </p>
          </div>
          <div className="hidden justify-center lg:flex">
            <ArrowRight size={28} className="text-brand-300" />
          </div>
          <div className="rounded-3xl bg-ink p-8 text-white sm:p-10">
            <LogoMark size={44} />
            <p className="mt-6 font-display text-3xl leading-tight font-extrabold tracking-[-0.03em] sm:text-4xl">
              One tool.
              <br />
              <span className="text-lime-400">Everything talks to everything.</span>
            </p>
            <p className="mt-4 text-brand-200">
              A signup on your page tags the contact, starts the right campaign and shows up on your dashboard — without a single integration to maintain.
            </p>
          </div>
        </Reveal>
        <p className="mt-6 text-xs text-slate-400">Typical entry-level prices of separate tools, for illustration.</p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- product

function FeatureCard({
  icon: Icon,
  kicker,
  title,
  body,
  points,
  mock,
  offset,
  delay,
}: {
  icon: LucideIcon;
  kicker: string;
  title: string;
  body: string;
  points: string[];
  mock: ReactNode;
  offset: string;
  delay: number;
}) {
  return (
    <Reveal delay={delay} className={offset}>
      <article className="flex h-full flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white">
        <div className="flex h-52 items-end justify-center overflow-hidden bg-brand-50 px-6 pt-6">{mock}</div>
        <div className="flex flex-1 flex-col p-7">
          <p className="flex items-center gap-2 text-sm font-semibold text-brand-600">
            <Icon size={16} /> {kicker}
          </p>
          <h3 className="mt-3 font-display text-2xl leading-tight font-extrabold tracking-[-0.03em] text-ink">{title}</h3>
          <p className="mt-3 text-slate-600">{body}</p>
          <ul className="mt-5 space-y-2 text-sm text-slate-700">
            {points.map((p) => (
              <li key={p} className="flex gap-2">
                <Check size={16} className="mt-0.5 shrink-0 text-brand-500" /> {p}
              </li>
            ))}
          </ul>
        </div>
      </article>
    </Reveal>
  );
}

const FunnelMock = () => (
  <div className="w-full max-w-[280px] rounded-t-xl border border-b-0 border-slate-200 bg-white p-3 shadow-float">
    <div className="flex items-center gap-1.5 border-b border-slate-100 pb-2">
      {[0, 1, 2].map((i) => (
        <span key={i} className="h-2 w-2 rounded-full bg-slate-200" />
      ))}
    </div>
    <div className="mt-3 space-y-2">
      <div className="h-3 w-3/4 rounded bg-ink" />
      <div className="h-2 w-full rounded bg-slate-200" />
      <div className="flex items-center gap-2 rounded-lg border-2 border-dashed border-brand-300 bg-brand-50 p-2">
        <GripVertical size={14} className="text-brand-400" />
        <div className="h-6 flex-1 rounded-md bg-white ring-1 ring-slate-200" />
        <div className="h-6 w-16 rounded-md bg-brand-500" />
      </div>
      <div className="h-2 w-2/3 rounded bg-slate-200" />
    </div>
  </div>
);

const EmailMock = () => (
  <div className="w-full max-w-[280px] space-y-2 pb-6">
    {[
      ['Day 0', 'Welcome to the challenge', 'bg-brand-500'],
      ['Day 2', 'Your first quick win', 'bg-brand-400'],
      ['Day 5', 'Ready for the next step?', 'bg-lime-400'],
    ].map(([day, subject, dot]) => (
      <div key={day} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-card">
        <span className={cx('h-2.5 w-2.5 shrink-0 rounded-full', dot)} />
        <span className="w-10 shrink-0 font-mono text-[11px] text-slate-400">{day}</span>
        <span className="truncate text-[13px] font-medium text-ink">{subject}</span>
      </div>
    ))}
  </div>
);

const ContactMock = () => (
  <div className="w-full max-w-[280px] rounded-t-xl border border-b-0 border-slate-200 bg-white p-4 shadow-float">
    <div className="flex items-center gap-3">
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700">AL</span>
      <span className="text-[13px] leading-tight">
        <b className="block font-semibold text-ink">Ana López</b>
        <span className="text-slate-500">ana@studio.co</span>
      </span>
    </div>
    <div className="mt-3 flex flex-wrap gap-1.5">
      {['webinar', 'buyer', 'vip'].map((t) => (
        <span key={t} className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700">
          {t}
        </span>
      ))}
    </div>
    <div className="mt-3 space-y-1.5 border-t border-slate-100 pt-3 text-[12px] text-slate-500">
      <p>• Opted in via “Free guide”</p>
      <p>• Opened “Your first quick win”</p>
    </div>
  </div>
);

function Product() {
  return (
    <section id="product" className="bg-white py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <Reveal className="max-w-2xl">
          <p className="text-sm font-semibold text-brand-600">Product</p>
          <h2 className="mt-3 font-display text-[clamp(34px,5vw,54px)] leading-[1.02] font-extrabold tracking-[-0.04em] text-ink">
            Three tools that climb together.
          </h2>
          <p className="mt-4 text-lg text-slate-600">Each step feeds the next. That’s the whole idea — and the logo.</p>
        </Reveal>
        {/* cards step up like the logo's pills */}
        <div className="mt-14 grid gap-6 lg:grid-cols-3 lg:items-end">
          <FeatureCard
            icon={LayoutTemplate}
            kicker="Funnels"
            title="Pages that turn visitors into leads."
            body="Drag-and-drop editor, ready-made templates, and your own domain."
            points={['Opt-in, sales and thank-you pages', 'Custom domains', 'Views and conversion per step']}
            mock={<FunnelMock />}
            offset="lg:mb-0"
            delay={0}
          />
          <FeatureCard
            icon={Mail}
            kicker="Emails"
            title="Emails that send themselves."
            body="Newsletters when you have news, automated campaigns for everything else."
            points={['Sequences with conditions', 'A/B-tested subject lines', 'Double opt-in and clean unsubscribes']}
            mock={<EmailMock />}
            offset="lg:mb-10"
            delay={120}
          />
          <FeatureCard
            icon={Tag}
            kicker="Contacts"
            title="Every contact, every tag, one place."
            body="A CRM that fills itself as people sign up, open and click."
            points={['Tags, timeline and segments', 'CSV import', 'Webhooks and a public API']}
            mock={<ContactMock />}
            offset="lg:mb-20"
            delay={240}
          />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- how

function How() {
  const steps = [
    { n: '01', title: 'Pick a template', body: 'Start from an opt-in or sales funnel and make it yours in the visual editor.', icon: LayoutTemplate },
    { n: '02', title: 'Connect the follow-up', body: 'Tag new sign-ups and drop them into an email campaign. No integrations, no Zapier.', icon: Split },
    { n: '03', title: 'Publish and grow', body: 'Go live on your domain, watch conversions per step, and test what works better.', icon: Globe },
  ];
  return (
    <section id="how" className="bg-ink py-24 text-white sm:py-32">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <Reveal className="max-w-2xl">
          <p className="text-sm font-semibold text-lime-400">How it works</p>
          <h2 className="mt-3 font-display text-[clamp(34px,5vw,54px)] leading-[1.02] font-extrabold tracking-[-0.04em]">
            Live this afternoon.
            <br />
            <span className="text-brand-300">Growing by next week.</span>
          </h2>
        </Reveal>
        <ol className="mt-16 grid gap-5 md:grid-cols-3">
          {steps.map((s, i) => (
            <Reveal key={s.n} delay={i * 120} className={cx(i === 1 && 'md:mt-10', i === 2 && 'md:mt-20')}>
              <li className="h-full rounded-3xl border border-white/10 bg-white/[0.04] p-7">
                <div className="flex items-center justify-between">
                  <span className={cx('rounded-full px-3 py-1 font-mono text-sm font-medium', i === 2 ? 'bg-lime-400 text-ink' : 'bg-brand-500 text-white')}>{s.n}</span>
                  <s.icon size={20} className="text-brand-300" />
                </div>
                <h3 className="mt-6 font-display text-xl font-extrabold tracking-[-0.02em]">{s.title}</h3>
                <p className="mt-2 text-brand-200">{s.body}</p>
              </li>
            </Reveal>
          ))}
        </ol>
        <Reveal className="mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            [FlaskConical, 'A/B subject tests'],
            [Upload, 'CSV import'],
            [Webhook, 'Webhooks and API'],
            [Globe, 'Custom domains'],
          ].map(([Icon, label]) => {
            const I = Icon as LucideIcon;
            return (
              <div key={label as string} className="flex items-center gap-3 rounded-2xl border border-white/10 px-4 py-3.5 text-sm font-medium text-brand-100">
                <I size={17} className="text-lime-400" /> {label as string}
              </div>
            );
          })}
        </Reveal>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- pricing

function Pricing() {
  const plans = [
    {
      name: 'Free',
      price: '$0',
      tagline: 'Everything you need to launch.',
      features: ['1 funnel', 'Up to 500 contacts', 'Unlimited emails to your list', '“Made with Scalo” badge'],
      cta: 'Start free',
    },
    {
      name: 'Pro',
      price: '$29',
      tagline: 'For creators getting real traction.',
      features: ['Unlimited funnels', 'Up to 10,000 contacts', 'Automated campaigns and A/B tests', 'Custom domain, no badge'],
      cta: 'Start with Pro',
      featured: true,
    },
    {
      name: 'Business',
      price: '$79',
      tagline: 'For teams that run on it.',
      features: ['Everything in Pro', 'Up to 50,000 contacts', 'Webhooks and API access', 'Priority support'],
      cta: 'Start with Business',
    },
  ];
  return (
    <section id="pricing" className="bg-brand-50 py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <Reveal className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold text-brand-600">Pricing</p>
          <h2 className="mt-3 font-display text-[clamp(34px,5vw,54px)] leading-[1.02] font-extrabold tracking-[-0.04em] text-ink">
            Start free. Pay when you scale.
          </h2>
          <p className="mt-4 text-lg text-slate-600">Simple monthly plans. Cancel anytime.</p>
        </Reveal>
        <div className="mt-14 grid gap-6 lg:grid-cols-3 lg:items-stretch">
          {plans.map((p, i) => (
            <Reveal key={p.name} delay={i * 100}>
              <div className={cx('flex h-full flex-col rounded-3xl p-8', p.featured ? 'bg-ink text-white' : 'border border-slate-200 bg-white text-ink')}>
                <div className="flex items-center justify-between">
                  <h3 className="font-display text-xl font-extrabold tracking-[-0.02em]">{p.name}</h3>
                  {p.featured && <span className="rounded-full bg-lime-400 px-2.5 py-0.5 text-xs font-semibold text-ink">Most popular</span>}
                </div>
                <p className={cx('mt-1 text-sm', p.featured ? 'text-brand-200' : 'text-slate-500')}>{p.tagline}</p>
                <p className="mt-6 flex items-baseline gap-1">
                  <span className="font-display text-5xl font-extrabold tracking-[-0.04em]">{p.price}</span>
                  <span className={cx('text-sm', p.featured ? 'text-brand-200' : 'text-slate-500')}>/month</span>
                </p>
                <ul className="mt-7 flex-1 space-y-3 text-sm">
                  {p.features.map((f) => (
                    <li key={f} className="flex gap-2.5">
                      <Check size={17} className={cx('mt-px shrink-0', p.featured ? 'text-lime-400' : 'text-brand-500')} />
                      <span className={p.featured ? 'text-brand-100' : 'text-slate-700'}>{f}</span>
                    </li>
                  ))}
                </ul>
                <Link
                  to="/register"
                  className={cx(
                    'mt-8 rounded-full py-3 text-center text-[15px] font-semibold transition-colors',
                    p.featured ? 'bg-lime-400 text-ink hover:bg-[#d4fa5c]' : 'bg-brand-500 text-white hover:bg-brand-600',
                  )}
                >
                  {p.cta}
                </Link>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- faq

function Faq() {
  const items = [
    ['Do I need to know how to code?', 'No. Pages are built with a drag-and-drop editor, and emails with the same blocks. If you can write a document, you can build a funnel.'],
    ['Can I use my own domain?', 'Yes. Point a domain or subdomain to Scalo and your funnels are served there, with HTTPS.'],
    ['Can I import my existing contacts?', 'Yes, from any CSV file. Tags and custom fields come along, and double opt-in can be applied to new sign-ups.'],
    ['Does it work with my other tools?', 'Scalo covers pages, emails and contacts on its own. For everything else there are webhooks and a public API.'],
    ['What happens when I outgrow the free plan?', 'Nothing breaks. Upgrade when you’re ready and keep everything you’ve built — pages, lists, campaigns and stats.'],
  ];
  return (
    <section id="faq" className="bg-white py-24 sm:py-32">
      <div className="mx-auto grid max-w-6xl gap-12 px-5 sm:px-8 lg:grid-cols-[1fr_1.4fr]">
        <Reveal>
          <p className="text-sm font-semibold text-brand-600">FAQ</p>
          <h2 className="mt-3 font-display text-[clamp(34px,5vw,48px)] leading-[1.02] font-extrabold tracking-[-0.04em] text-ink">Questions, answered.</h2>
        </Reveal>
        <Reveal className="divide-y divide-slate-200 border-y border-slate-200">
          {items.map(([q, a]) => (
            <details key={q} className="group py-5">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-6 text-lg font-semibold text-ink [&::-webkit-details-marker]:hidden">
                {q}
                <Plus size={20} className="shrink-0 text-brand-500 transition-transform group-open:rotate-45" />
              </summary>
              <p className="mt-3 pr-10 text-slate-600">{a}</p>
            </details>
          ))}
        </Reveal>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- final cta + footer

function FinalCta() {
  const { user } = useAuth();
  return (
    <section className="relative overflow-hidden bg-ink py-24 text-white sm:py-32">
      <svg className="pointer-events-none absolute -right-16 -bottom-16 w-[340px] opacity-90 sm:w-[460px]" viewBox="12 12.5 40 39" aria-hidden="true">
        <rect x="12" y="38.5" width="24" height="13" rx="6.5" fill="#2A1F8C" />
        <rect x="20" y="25.5" width="24" height="13" rx="6.5" fill="#5B4BFF" />
        <rect x="28" y="12.5" width="24" height="13" rx="6.5" fill="#C6F432" />
      </svg>
      <Reveal className="relative mx-auto max-w-6xl px-5 sm:px-8">
        <h2 className="max-w-2xl font-display text-[clamp(40px,6vw,72px)] leading-[0.98] font-extrabold tracking-[-0.045em]">
          Your next customer
          <br />
          is one step away.
        </h2>
        <p className="mt-6 max-w-md text-lg text-brand-200">Set up your first funnel in minutes. Free, no credit card.</p>
        <div className="mt-9">
          <PrimaryCta to={user ? '/dashboard' : '/register'} dark>
            {user ? 'Open your dashboard' : 'Start free'}
          </PrimaryCta>
        </div>
      </Reveal>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-white/10 bg-ink py-10 text-brand-300">
      <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 px-5 text-sm sm:flex-row sm:items-center sm:px-8">
        <Logo dark />
        <nav className="flex flex-wrap gap-6">
          <a href="#product" className="hover:text-white">
            Product
          </a>
          <a href="#pricing" className="hover:text-white">
            Pricing
          </a>
          <a href="#faq" className="hover:text-white">
            FAQ
          </a>
          <Link to="/login" className="hover:text-white">
            Log in
          </Link>
        </nav>
        <p>© {new Date().getFullYear()} Scalo</p>
      </div>
    </footer>
  );
}

/** Shown once after the deletion of an account (flag set by Paramètres → Données et compte). */
function AccountDeletedNotice() {
  const [show, setShow] = useState(() => {
    try {
      return sessionStorage.getItem(ACCOUNT_DELETED_FLAG) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      sessionStorage.removeItem(ACCOUNT_DELETED_FLAG);
    } catch {
      /* storage unavailable */
    }
  }, []);
  if (!show) return null;
  return (
    <div role="status" className="fixed inset-x-0 top-20 z-[60] flex justify-center px-4">
      <div className="flex max-w-xl items-start gap-3 rounded-2xl bg-white px-4 py-3 text-sm text-slate-700 shadow-pop ring-1 ring-slate-200">
        <p>
          <strong className="text-ink">Votre compte a été supprimé.</strong> Vos données, vos pages publiques et vos accès ont été effacés. Merci d’avoir utilisé Scalo.
        </p>
        <button type="button" onClick={() => setShow(false)} className="-mr-1 rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Fermer">
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

export function LandingPage() {
  useEffect(() => {
    const prev = document.title;
    document.title = 'Scalo — Funnels, emails and contacts. Built to scale.';
    return () => void (document.title = prev);
  }, []);
  return (
    <div className="landing-root min-h-full bg-ink">
      <AccountDeletedNotice />
      <Nav />
      <main>
        <Hero />
        <Stack />
        <Product />
        <How />
        <Pricing />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
