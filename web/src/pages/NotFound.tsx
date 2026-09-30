import { Link } from 'react-router';
import { Compass } from 'lucide-react';
import { Button, EmptyState } from '../components/ui';

export function NotFoundPage() {
  return (
    <EmptyState
      icon={Compass}
      title="Page introuvable"
      description="Cette page n’existe pas ou a été déplacée."
      action={
        <Link to="/dashboard">
          <Button>Retour au tableau de bord</Button>
        </Link>
      }
    />
  );
}
