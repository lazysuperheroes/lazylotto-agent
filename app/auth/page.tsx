import type { Metadata } from 'next';
import { AuthFlow } from './AuthFlow';

export const metadata: Metadata = {
  title: 'LazyLotto Agent \u2014 Authenticate',
};

export default function AuthPage() {
  return <AuthFlow />;
}
