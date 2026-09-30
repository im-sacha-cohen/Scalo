// OAuth 2.0 authorization server: scopes (with the French texts of the consent screen) and API shapes.

export const OAUTH_SCOPES = [
  'profile',
  'contacts:read',
  'contacts:write',
  'tags:write',
  'funnels:read',
  'emails:read',
  'campaigns:write',
  'purchases:write',
  'sales:read',
  'offline_access',
] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

/** Consent screen / developer docs: what each scope lets an application do. */
export const OAUTH_SCOPE_INFO: Record<OAuthScope, { label: string; description: string }> = {
  profile: { label: 'Votre profil', description: 'Voir le nom et l’adresse email de votre compte.' },
  'contacts:read': { label: 'Lire vos contacts', description: 'Consulter vos contacts, leurs informations et leurs tags.' },
  'contacts:write': { label: 'Gérer vos contacts', description: 'Créer, modifier et supprimer des contacts.' },
  'tags:write': {
    label: 'Taguer vos contacts',
    description: 'Ajouter et retirer des tags sur vos contacts (un tag peut déclencher vos campagnes automatiques).',
  },
  'funnels:read': { label: 'Lire vos tunnels', description: 'Consulter vos tunnels de vente, leurs étapes et leurs statistiques.' },
  'emails:read': { label: 'Lire vos emails', description: 'Consulter vos newsletters, vos campagnes et leurs statistiques.' },
  'campaigns:write': { label: 'Inscrire à vos campagnes', description: 'Inscrire des contacts à vos campagnes email automatiques.' },
  'purchases:write': {
    label: 'Enregistrer des achats',
    description: 'Enregistrer les achats de vos contacts (un achat peut déclencher vos automatisations).',
  },
  'sales:read': { label: 'Lire vos ventes', description: 'Consulter vos produits, vos commandes et leurs montants.' },
  offline_access: {
    label: 'Accès permanent',
    description: 'Garder l’accès quand vous n’utilisez pas l’application, jusqu’à ce que vous le révoquiez.',
  },
};

export const isOAuthScope = (s: string): s is OAuthScope => (OAUTH_SCOPES as readonly string[]).includes(s);

export type OAuthClientType = 'confidential' | 'public';

/** An application registered in "Développeurs" (owner view). */
export interface OAuthApp {
  id: number;
  client_id: string;
  name: string;
  description: string;
  website: string | null;
  logo_url: string | null;
  type: OAuthClientType;
  redirect_uris: string[];
  scopes: OAuthScope[];
  /** Last 4 characters of the current secret (confidential clients). */
  secret_hint: string | null;
  secret_rotated_at: string | null;
  /** Users who authorized the application. */
  authorizations_count: number;
  created_at: string;
  updated_at: string;
}

/** Creation / secret rotation: the secret is returned once, never again. */
export type OAuthAppWithSecret = OAuthApp & { client_secret?: string };

/** GET /api/oauth/requests/:id — what the consent screen shows. */
export interface OAuthConsentRequest {
  request_id: string;
  client: {
    client_id: string;
    name: string;
    description: string;
    website: string | null;
    logo_url: string | null;
    type: OAuthClientType;
    owner_name: string;
  };
  scopes: OAuthScope[];
  redirect_uri: string;
  /** The user already granted these scopes (or more) and prompt=consent was not requested: the screen can be skipped. */
  remembered: boolean;
  prompt_consent: boolean;
  expires_at: string;
}

/** "Applications connectées": an application the user authorized. */
export interface OAuthAuthorization {
  client: { client_id: string; name: string; description: string; website: string | null; logo_url: string | null; owner_name: string };
  scopes: OAuthScope[];
  granted_at: string;
  updated_at: string;
  last_used_at: string | null;
}
