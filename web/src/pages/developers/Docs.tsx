// Inline documentation of the OAuth 2.0 provider and the public API (Développeurs).
import { OAUTH_SCOPES, OAUTH_SCOPE_INFO } from '@scalo/shared';
import { Card, CardHeader } from '../../components/ui';
import { BookOpen } from 'lucide-react';
import { CodeBlock } from '../oauth/common';

export const ORIGIN = window.location.origin;

const API_ROUTES: [string, string, string][] = [
  ['GET', '/api/v1/me', 'profile'],
  ['GET', '/api/v1/contacts?search=&tag_id=&status=&segment_id=&page=1&limit=50', 'contacts:read'],
  ['GET', '/api/v1/contacts/:id', 'contacts:read'],
  ['POST', '/api/v1/contacts  {email, first_name?, last_name?, phone?, tags?, fields?}', 'contacts:write'],
  ['PATCH', '/api/v1/contacts/:id', 'contacts:write'],
  ['DELETE', '/api/v1/contacts/:id', 'contacts:write'],
  ['POST', '/api/v1/contacts/:id/tags  {name}', 'tags:write'],
  ['DELETE', '/api/v1/contacts/:id/tags/:tagId', 'tags:write'],
  ['GET', '/api/v1/tags', 'contacts:read'],
  ['GET', '/api/v1/funnels', 'funnels:read'],
  ['GET', '/api/v1/broadcasts', 'emails:read'],
  ['GET', '/api/v1/campaigns', 'emails:read'],
  ['POST', '/api/v1/campaigns/:id/enroll  {contact_id}', 'campaigns:write'],
  ['GET', '/api/v1/custom-fields', 'contacts:read'],
  ['POST', '/api/v1/custom-fields  {label, type, key?, options?}', 'contacts:write'],
  ['GET', '/api/v1/segments', 'contacts:read'],
  ['GET', '/api/v1/segments/:id/contacts', 'contacts:read'],
  ['POST', '/api/v1/purchases  {contact_id | email, product, amount?, currency?, external_id?}', 'purchases:write'],
  ['GET', '/api/v1/products', 'sales:read'],
  ['GET', '/api/v1/orders  ?status&search&product_id&from&to&page&limit', 'sales:read'],
  ['GET', '/api/v1/orders/:id', 'sales:read'],
];

export function OAuthDocs() {
  return (
    <Card>
      <CardHeader icon={BookOpen} title="Documentation" description="OAuth 2.0 (RFC 6749) : code d’autorisation + PKCE (RFC 7636), jetons de rafraîchissement avec rotation." />
      <div className="space-y-6 text-sm text-slate-700">
        <section>
          <h4 className="font-semibold text-slate-900">1. Le flux</h4>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5">
            <li>
              Votre application redirige l’utilisateur vers <code className="font-mono text-[13px]">{ORIGIN}/oauth/authorize</code> avec{' '}
              <code className="font-mono text-[13px]">response_type=code</code>, <code className="font-mono text-[13px]">client_id</code>,{' '}
              <code className="font-mono text-[13px]">redirect_uri</code> (identique à une URL enregistrée), <code className="font-mono text-[13px]">scope</code>,{' '}
              <code className="font-mono text-[13px]">state</code> et le PKCE <code className="font-mono text-[13px]">code_challenge</code> (S256).
            </li>
            <li>L’utilisateur se connecte et accepte (ou refuse) sur l’écran d’autorisation.</li>
            <li>
              Retour sur votre <code className="font-mono text-[13px]">redirect_uri</code> avec <code className="font-mono text-[13px]">code</code>,{' '}
              <code className="font-mono text-[13px]">state</code> (vérifiez-le) et <code className="font-mono text-[13px]">iss</code> (= <code className="font-mono text-[13px]">{ORIGIN}</code>) — ou{' '}
              <code className="font-mono text-[13px]">error=access_denied</code>.
            </li>
            <li>
              Votre serveur échange le code (valable 60 s, usage unique) sur <code className="font-mono text-[13px]">POST {ORIGIN}/oauth/token</code>.
            </li>
            <li>
              Appelez l’API avec <code className="font-mono text-[13px]">Authorization: Bearer scalo_at_…</code> (1 h), puis rafraîchissez avec le{' '}
              <code className="font-mono text-[13px]">refresh_token</code> (30 jours, scope <code className="font-mono text-[13px]">offline_access</code>). Chaque rafraîchissement
              renvoie un <strong>nouveau</strong> refresh token : réutiliser l’ancien révoque toute l’autorisation.
            </li>
          </ol>
        </section>

        <section>
          <h4 className="font-semibold text-slate-900">2. Endpoints</h4>
          <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-left text-[13px]">
              <tbody className="divide-y divide-slate-100">
                {[
                  ['Métadonnées (RFC 8414)', 'GET /.well-known/oauth-authorization-server'],
                  ['Autorisation', 'GET /oauth/authorize'],
                  ['Jetons', 'POST /oauth/token — grant_type=authorization_code | refresh_token'],
                  ['Révocation (RFC 7009)', 'POST /oauth/revoke — token'],
                  ['Introspection (RFC 7662)', 'POST /oauth/introspect — token (applications confidentielles)'],
                ].map(([k, v]) => (
                  <tr key={k}>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-500">{k}</td>
                    <td className="px-3 py-2 font-mono text-slate-800">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Authentification du client : <code className="font-mono">client_secret_basic</code> (en-tête <code className="font-mono">Authorization: Basic</code>) ou{' '}
            <code className="font-mono">client_secret_post</code> ; application publique : <code className="font-mono">client_id</code> seul + PKCE. Corps en{' '}
            <code className="font-mono">application/x-www-form-urlencoded</code> (JSON accepté).
          </p>
        </section>

        <section>
          <h4 className="font-semibold text-slate-900">3. Scopes</h4>
          <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-left text-[13px]">
              <tbody className="divide-y divide-slate-100">
                {OAUTH_SCOPES.map((s) => (
                  <tr key={s}>
                    <td className="px-3 py-2 font-mono whitespace-nowrap text-slate-800">{s}</td>
                    <td className="px-3 py-2 text-slate-600">{OAUTH_SCOPE_INFO[s].description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h4 className="font-semibold text-slate-900">4. API</h4>
          <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-left text-[13px]">
              <tbody className="divide-y divide-slate-100">
                {API_ROUTES.map(([m, p, s]) => (
                  <tr key={m + p}>
                    <td className="w-16 px-3 py-2 font-mono text-xs font-semibold text-slate-500">{m}</td>
                    <td className="px-3 py-2 font-mono text-slate-800">{p}</td>
                    <td className="px-3 py-2 font-mono text-xs whitespace-nowrap text-brand-700">{s}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Erreurs : <code className="font-mono">401 invalid_token</code> (jeton absent, expiré ou révoqué), <code className="font-mono">403 insufficient_scope</code> (champ{' '}
            <code className="font-mono">scope</code> = scope requis), <code className="font-mono">429</code> au-delà de 120 requêtes par minute et par autorisation (en-têtes{' '}
            <code className="font-mono">X-RateLimit-*</code> et <code className="font-mono">Retry-After</code>).
          </p>
          <CodeBlock
            className="mt-3"
            code={`curl "${ORIGIN}/api/v1/contacts?limit=10" \\\n  -H "Authorization: Bearer $ACCESS_TOKEN"`}
          />
        </section>

        <section>
          <h4 className="font-semibold text-slate-900">5. Sécurité</h4>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-600">
            <li>Ne mettez jamais le client_secret dans une application web ou mobile : utilisez une application publique + PKCE.</li>
            <li>Générez un <code className="font-mono text-[13px]">state</code> aléatoire par demande et vérifiez-le au retour, ainsi que <code className="font-mono text-[13px]">iss</code>.</li>
            <li>Stockez les jetons côté serveur ; ils sont préfixés (<code className="font-mono text-[13px]">scalo_at_</code>, <code className="font-mono text-[13px]">scalo_rt_</code>, <code className="font-mono text-[13px]">scalo_cs_</code>) pour être détectés en cas de fuite.</li>
            <li>Révoquez les jetons à la déconnexion (<code className="font-mono text-[13px]">POST /oauth/revoke</code>).</li>
          </ul>
        </section>
      </div>
    </Card>
  );
}
