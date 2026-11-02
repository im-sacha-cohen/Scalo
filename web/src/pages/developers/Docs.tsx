// Développeurs → API REST and OAuth 2.0: the public API (/api/v1) and the authorization server that issues its tokens.
import { OAUTH_SCOPES, OAUTH_SCOPE_INFO } from '@scalo/shared';
import { Building2, CircleCheck, Clock, KeyRound, RefreshCw } from 'lucide-react';
import { Card } from '../../components/ui';
import { CodeBlock, CopyValue } from '../oauth/common';
import { C, Fact, Method, Note, ORIGIN, Scope, Section, Steps } from './doc-ui';

export type Route = [method: string, path: string, what: string, scope: string, body?: string];
export const API_GROUPS: { title: string; routes: Route[] }[] = [
  { title: 'Compte', routes: [['GET', '/me', 'Compte connecté', 'profile']] },
  {
    title: 'Contacts',
    routes: [
      ['GET', '/contacts', 'Lister et chercher', 'contacts:read', '?search & tag_id & status & segment_id & page & limit'],
      ['GET', '/contacts/:id', 'Consulter un contact', 'contacts:read'],
      ['POST', '/contacts', 'Créer un contact', 'contacts:write', '{ email, first_name?, last_name?, phone?, tags?, fields? }'],
      ['PATCH', '/contacts/:id', 'Modifier un contact', 'contacts:write'],
      ['DELETE', '/contacts/:id', 'Supprimer un contact', 'contacts:write'],
      ['POST', '/contacts/:id/tags', 'Ajouter un tag', 'tags:write', '{ name }'],
      ['DELETE', '/contacts/:id/tags/:tagId', 'Retirer un tag', 'tags:write'],
      ['GET', '/tags', 'Tags et nombre de contacts', 'contacts:read'],
      ['GET', '/custom-fields', 'Champs personnalisés', 'contacts:read'],
      ['POST', '/custom-fields', 'Créer un champ', 'contacts:write', '{ label, type, key?, options? }'],
      ['GET', '/segments', 'Segments', 'contacts:read'],
      ['GET', '/segments/:id/contacts', 'Contacts d’un segment', 'contacts:read'],
    ],
  },
  { title: 'Tunnels', routes: [['GET', '/funnels', 'Tunnels, étapes et statistiques', 'funnels:read']] },
  {
    title: 'Newsletters',
    routes: [
      ['GET', '/broadcasts', 'Lister les newsletters', 'emails:read'],
      ['GET', '/broadcasts/:id', 'Consulter une newsletter', 'emails:read'],
      ['POST', '/broadcasts', 'Rédiger une newsletter', 'emails:write', '{ subject, paragraphs, preheader?, button_label?, button_url?, tag_id?, segment_id? }'],
      ['PATCH', '/broadcasts/:id', 'La modifier (paragraphs remplace le contenu)', 'emails:write'],
      ['POST', '/broadcasts/:id/test', 'S’envoyer un test', 'emails:write', '{ email }'],
      ['POST', '/broadcasts/:id/schedule', 'Programmer l’envoi', 'emails:write', '{ scheduled_at }'],
      ['POST', '/broadcasts/:id/unschedule', 'Annuler la programmation', 'emails:write'],
    ],
  },
  {
    title: 'Campagnes',
    routes: [
      ['GET', '/campaigns', 'Lister les campagnes', 'emails:read'],
      ['GET', '/campaigns/:id', 'Consulter une campagne et ses emails', 'emails:read'],
      ['POST', '/campaigns', 'Créer une campagne', 'emails:write', '{ name, trigger_tag?, stop_tag? }'],
      ['POST', '/campaigns/:id/emails', 'Ajouter un email', 'emails:write', '{ subject, delay_days, paragraphs, … }'],
      ['PATCH', '/campaign-emails/:id', 'Modifier un email', 'emails:write'],
      ['POST', '/campaigns/:id/enroll', 'Inscrire un contact', 'campaigns:write', '{ contact_id }'],
    ],
  },
  {
    title: 'Ventes',
    routes: [
      ['POST', '/purchases', 'Enregistrer un achat', 'purchases:write', '{ contact_id | email, product, amount?, currency?, external_id? }'],
      ['GET', '/products', 'Produits', 'sales:read'],
      ['GET', '/orders', 'Commandes', 'sales:read', '?status & search & product_id & from & to & page & limit'],
      ['GET', '/orders/:id', 'Consulter une commande', 'sales:read'],
    ],
  },
];

export const OAUTH_ENDPOINTS: [string, string][] = [
  ['GET /oauth/authorize', 'Écran d’autorisation.'],
  ['POST /oauth/token', 'Jetons : authorization_code ou refresh_token.'],
  ['POST /oauth/revoke', 'Révoquer un jeton (RFC 7009).'],
  ['POST /oauth/introspect', 'Inspecter un jeton (RFC 7662, applications confidentielles).'],
  ['GET /.well-known/oauth-authorization-server', 'Métadonnées du serveur (RFC 8414).'],
];

export const ERRORS: [string, string][] = [
  ['400 invalid_request', 'Paramètre manquant ou invalide.'],
  ['401 invalid_token', 'Jeton absent, expiré ou révoqué.'],
  ['403 insufficient_scope', 'Le jeton n’a pas le scope requis (indiqué dans le champ scope).'],
  ['403 workspace_forbidden', 'L’espace demandé dans X-Scalo-Workspace n’est pas couvert par l’autorisation.'],
  ['429', 'Plus de 120 requêtes par minute (en-têtes X-RateLimit-* et Retry-After).'],
];

function Table({ rows }: { rows: [string, string][] }) {
  return (
    <Card padded={false} className="overflow-hidden">
      <dl className="divide-y divide-slate-100">
        {rows.map(([k, v]) => (
          <div key={k} className="grid gap-1 px-4 py-3 sm:grid-cols-[220px_1fr] sm:gap-4">
            <dt className="font-mono text-[12.5px] font-medium text-slate-800">{k}</dt>
            <dd className="text-sm text-slate-600">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

export function ApiDocs({ onOAuth }: { onOAuth: () => void }) {
  return (
    <div className="space-y-10">
      <Card padded={false} className="overflow-hidden">
        <div className="grid grid-cols-1 gap-6 p-6 lg:grid-cols-2 lg:gap-10 [&>*]:min-w-0">
          <div>
            <h2 className="font-display text-xl font-extrabold tracking-[-0.02em] text-ink">API REST</h2>
            <p className="mt-1.5 text-sm text-slate-600">
              Des requêtes HTTP et du JSON pour lire et modifier vos contacts, emails et ventes depuis votre code. Chaque appel porte un jeton d’accès obtenu par{' '}
              <button onClick={onOAuth} className="font-medium text-brand-700 hover:underline">
                OAuth 2.0
              </button>
              .
            </p>
            <p className="mt-4 mb-1.5 text-xs font-medium text-slate-500">URL de base</p>
            <CopyValue value={`${ORIGIN}/api/v1`} className="bg-white py-1.5" />
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-slate-500">Premier appel</p>
            <CodeBlock code={`curl "${ORIGIN}/api/v1/contacts?limit=10" \\\n  -H "Authorization: Bearer $ACCESS_TOKEN"`} />
          </div>
        </div>
      </Card>

      <Section title="Endpoints" description="Chemins relatifs à l’URL de base. Chaque endpoint demande un scope ; le jeton doit l’avoir reçu.">
        <div className="space-y-4">
          {API_GROUPS.map((g) => (
            <Card key={g.title} padded={false} className="overflow-hidden">
              <p className="border-b border-slate-100 bg-slate-50/70 px-4 py-2.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">{g.title}</p>
              <ul className="divide-y divide-slate-100">
                {g.routes.map(([m, path, what, scope, body]) => (
                  <li key={m + path} className="flex flex-wrap items-start gap-x-3 gap-y-1.5 px-4 py-3">
                    <Method m={m} />
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-[13px] font-medium break-all text-slate-900">{path}</p>
                      <p className="text-sm text-slate-500">{what}</p>
                      {body && <p className="mt-1 font-mono text-[11.5px] break-words text-slate-400">{body}</p>}
                    </div>
                    <Scope s={scope} />
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      </Section>

      <Section title="Espaces de travail">
        <Note icon={Building2}>
          Un jeton donné pour un espace n’agit que sur cet espace. Un jeton donné pour « Tous mes espaces » choisit l’espace de chaque requête avec l’en-tête{' '}
          <C>X-Scalo-Workspace: &lt;id&gt;</C> (par défaut : l’espace depuis lequel l’accès a été donné).
        </Note>
      </Section>

      <Section title="Erreurs" description="Réponses JSON avec un champ error, et error_description quand c’est utile.">
        <Table rows={ERRORS} />
      </Section>
    </div>
  );
}

export function OAuthDocs() {
  return (
    <div className="space-y-10">
      <Card padded={false} className="overflow-hidden">
        <div className="p-6">
          <h2 className="font-display text-xl font-extrabold tracking-[-0.02em] text-ink">OAuth 2.0</h2>
          <p className="mt-1.5 max-w-3xl text-sm text-slate-600">
            Votre application obtient des jetons d’accès avec l’accord de chaque utilisateur : code d’autorisation avec PKCE (S256), jetons de rafraîchissement avec rotation.
            Commencez par créer une application pour obtenir un <C>client_id</C>.
          </p>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <Fact icon={Clock} title="Code : 60 secondes">
              À usage unique, à échanger aussitôt contre des jetons.
            </Fact>
            <Fact icon={KeyRound} title="Jeton d’accès : 1 heure">
              Envoyé dans <C>Authorization: Bearer</C>.
            </Fact>
            <Fact icon={RefreshCw} title="Rafraîchissement : 30 jours">
              Avec le scope <C>offline_access</C>. Chaque usage en donne un nouveau.
            </Fact>
          </div>
        </div>
      </Card>

      <Section title="Le parcours">
        <Card>
          <Steps
            steps={[
              {
                title: 'Redirigez l’utilisateur vers l’écran d’autorisation',
                body: (
                  <>
                    <C>GET {ORIGIN}/oauth/authorize</C> avec <C>response_type=code</C>, <C>client_id</C>, <C>redirect_uri</C> (identique à une adresse enregistrée), <C>scope</C>,{' '}
                    <C>state</C> et <C>code_challenge</C> (S256).
                  </>
                ),
              },
              { title: 'L’utilisateur se connecte et accepte', body: 'Il choisit l’espace de travail et voit la liste des droits demandés.' },
              {
                title: 'Récupérez le code',
                body: (
                  <>
                    Retour sur votre <C>redirect_uri</C> avec <C>code</C>, <C>state</C> et <C>iss</C> — ou <C>error=access_denied</C> s’il refuse. Vérifiez <C>state</C> et <C>iss</C>.
                  </>
                ),
              },
              {
                title: 'Échangez-le contre des jetons',
                body: (
                  <>
                    <C>POST {ORIGIN}/oauth/token</C> avec <C>grant_type=authorization_code</C>, le code et le <C>code_verifier</C>.
                  </>
                ),
              },
              {
                title: 'Appelez l’API, rafraîchissez',
                body: (
                  <>
                    Quand le jeton expire, <C>grant_type=refresh_token</C>. Réutiliser un ancien refresh token révoque toute l’autorisation.
                  </>
                ),
              },
            ]}
          />
        </Card>
      </Section>

      <Section
        title="Endpoints"
        description={
          <>
            Authentification du client : <C>client_secret_basic</C> ou <C>client_secret_post</C> ; application publique : <C>client_id</C> seul avec PKCE. Corps en{' '}
            <C>application/x-www-form-urlencoded</C> (JSON accepté).
          </>
        }
      >
        <Table rows={OAUTH_ENDPOINTS} />
      </Section>

      <Section title="Scopes" description="Demandez seulement ce dont votre application a besoin : l’utilisateur voit chaque droit avant d’accepter.">
        <Card padded={false} className="overflow-hidden">
          <ul className="divide-y divide-slate-100">
            {OAUTH_SCOPES.map((s) => (
              <li key={s} className="grid gap-1 px-4 py-3 sm:grid-cols-[220px_1fr] sm:gap-4">
                <span>
                  <Scope s={s} />
                </span>
                <span className="text-sm text-slate-600">
                  <strong className="font-medium text-slate-800">{OAUTH_SCOPE_INFO[s].label}.</strong> {OAUTH_SCOPE_INFO[s].description}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </Section>

      <Section title="Sécurité">
        <Card>
          <ul className="space-y-2.5 text-sm text-slate-600">
            {[
              <>Ne mettez jamais le <C>client_secret</C> dans une application web ou mobile : utilisez une application publique avec PKCE.</>,
              <>Générez un <C>state</C> aléatoire par demande et vérifiez-le au retour, ainsi que <C>iss</C>.</>,
              <>
                Gardez les jetons côté serveur. Leurs préfixes (<C>scalo_at_</C>, <C>scalo_rt_</C>, <C>scalo_cs_</C>) permettent de les détecter en cas de fuite.
              </>,
              <>Révoquez les jetons à la déconnexion de l’utilisateur.</>,
            ].map((t, i) => (
              <li key={i} className="flex gap-2.5">
                <CircleCheck size={16} className="mt-0.5 shrink-0 text-emerald-600" />
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </Card>
      </Section>
    </div>
  );
}
