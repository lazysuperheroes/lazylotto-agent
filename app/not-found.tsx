import Link from 'next/link';
import Image from 'next/image';

export default function NotFound() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-12">
      <Image
        src="https://docs.lazysuperheroes.com/logo.svg"
        alt="Lazy Superheroes"
        width={144}
        height={48}
        className="mb-8 h-12 w-auto"
        priority
        unoptimized
      />
      <p className="label-caps-brand-lg mb-2">Issue not found</p>
      <h1 className="display-lg mb-2 text-brand">404</h1>
      <p className="type-body mb-6 text-muted">
        This page is somewhere else in the LazyVerse.
      </p>
      <Link href="/auth" className="btn-primary-sm">
        Sign in →
      </Link>
    </div>
  );
}
