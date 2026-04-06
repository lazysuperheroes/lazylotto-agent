import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4">
      <img
        src="https://docs.lazysuperheroes.com/logo.svg"
        alt="Lazy Superheroes"
        width={144}
        height={48}
        className="mb-8 h-12 w-auto"
      />
      <h1 className="font-heading text-4xl text-brand">404</h1>
      <p className="mt-2 text-muted">Page not found</p>
      <Link
        href="/auth"
        className="mt-6 rounded-lg bg-primary px-6 py-2.5 text-white transition-opacity hover:opacity-90"
      >
        Go to Auth Page
      </Link>
    </div>
  );
}
