'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    const token = localStorage.getItem('lazylotto:sessionToken');
    if (token) {
      const tier = localStorage.getItem('lazylotto:tier') ?? '';
      router.replace(tier === 'admin' || tier === 'operator' ? '/admin' : '/dashboard');
    } else {
      router.replace('/auth');
    }
  }, [router]);

  // Brief loading state while redirect is determined
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-brand" />
    </div>
  );
}
