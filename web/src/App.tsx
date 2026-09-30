import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation } from 'react-router';
import { AuthProvider, useAuth } from './lib/auth';
import { EditionProvider } from './lib/edition';
import { eeWeb } from './lib/ee';
import { ToastProvider } from './components/Toast';
import { ConfirmProvider } from './components/ConfirmDialog';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { LoginPage, RegisterPage } from './pages/AuthPages';
import { DashboardPage } from './pages/Dashboard';
import { ContactsPage } from './pages/contacts/ContactsPage';
import { ContactDetailPage } from './pages/contacts/ContactDetail';
import { MigratePage } from './pages/migrate/MigratePage';
import { AutomationsPage } from './pages/automations/AutomationsPage';
import { AutomationEditorPage } from './pages/automations/AutomationEditor';
import { FunnelsPage } from './pages/funnels/FunnelsPage';
import { FunnelDetailPage } from './pages/funnels/FunnelDetail';
import { StepEditorPage } from './pages/funnels/StepEditor';
import { EmailsPage } from './pages/emails/EmailsPage';
import { BroadcastPage } from './pages/emails/BroadcastEditor';
import { CampaignDetailPage } from './pages/emails/CampaignDetail';
import { SettingsPage } from './pages/SettingsPage';
import { SalesPage } from './pages/sales/SalesPage';
import { OrderDetailPage } from './pages/sales/OrderDetail';
import { AffiliationPage } from './pages/affiliates/AffiliationPage';
import { NotFoundPage } from './pages/NotFound';
import { ConsentPage } from './pages/oauth/ConsentPage';
import { TestCallbackPage } from './pages/oauth/TestCallbackPage';
import { DevelopersPage } from './pages/developers/DevelopersPage';
import { DeveloperAppPage } from './pages/developers/DeveloperAppPage';
import { LandingPage } from './pages/landing/LandingPage';
import { SharePage } from './pages/funnels/growth/SharePage';
import { CoursesPage } from './pages/courses/CoursesPage';
import { CourseDetailPage } from './pages/courses/CourseDetail';
import { LessonEditorPage } from './pages/courses/LessonEditor';

function FullScreenLoader() {
  return (
    <div className="flex h-full items-center justify-center bg-slate-50">
      <Spinner size={32} />
    </div>
  );
}

function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <FullScreenLoader />;
  // visitors hitting the root get the marketing page instead of a login wall
  if (!user && location.pathname === '/') return <LandingPage />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <Outlet />;
}

function GuestOnly() {
  const { user, loading } = useAuth();
  if (loading) return <FullScreenLoader />;
  if (user) return <Navigate to="/" replace />;
  return <Outlet />;
}

const router = createBrowserRouter([
  // dev only: a redirect URI that shows the code / error sent back by the authorization server
  ...(import.meta.env.DEV ? [{ path: '/oauth/test-callback', element: <TestCallbackPage /> }] : []),
  // public marketing page, reachable even when signed in
  { path: '/home', element: <LandingPage /> },
  // shared funnel: public read-only preview, "Importer dans mon compte" asks to sign in
  { path: '/share/:token', element: <SharePage /> },
  // Enterprise edition, when ee/ is installed (team invitation link)
  ...(eeWeb?.publicRoutes ?? []),
  {
    element: <GuestOnly />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/register', element: <RegisterPage /> },
    ],
  },
  {
    element: <RequireAuth />,
    children: [
      // OAuth consent screen (authorization server): full screen, login required
      { path: '/oauth/consent', element: <ConsentPage /> },
      // full-screen editors (no sidebar)
      { path: '/funnels/:id/steps/:stepId/edit', element: <StepEditorPage /> },
      { path: '/emails/broadcasts/:id', element: <BroadcastPage /> },
      { path: '/courses/:id/lessons/:lessonId/edit', element: <LessonEditorPage /> },
      {
        element: <Layout />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: '/contacts', element: <ContactsPage /> },
          { path: '/contacts/:id', element: <ContactDetailPage /> },
          { path: '/migrate', element: <MigratePage /> },
          { path: '/automations', element: <AutomationsPage /> },
          { path: '/automations/:id', element: <AutomationEditorPage /> },
          { path: '/courses', element: <CoursesPage /> },
          { path: '/courses/:id', element: <CourseDetailPage /> },
          { path: '/funnels', element: <FunnelsPage /> },
          { path: '/funnels/:id', element: <FunnelDetailPage /> },
          { path: '/emails', element: <EmailsPage /> },
          { path: '/emails/campaigns/:id', element: <CampaignDetailPage /> },
          { path: '/sales', element: <SalesPage /> },
          { path: '/sales/orders/:id', element: <OrderDetailPage /> },
          { path: '/affiliation', element: <AffiliationPage /> },
          { path: '/settings', element: <SettingsPage /> },
          { path: '/developers', element: <DevelopersPage /> },
          { path: '/developers/:id', element: <DeveloperAppPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);

export function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <ConfirmProvider>
          <EditionProvider>
            <RouterProvider router={router} />
          </EditionProvider>
        </ConfirmProvider>
      </ToastProvider>
    </AuthProvider>
  );
}
