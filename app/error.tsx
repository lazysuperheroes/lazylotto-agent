'use client';

import Image from 'next/image';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
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
      <p className="label-caps-destructive mb-2">Trouble in the LazyVerse</p>
      <h1 className="display-md mb-3 text-destructive">
        Something went wrong
      </h1>
      <p className="type-body prose-width mb-6 text-center text-muted">
        {error.message}
      </p>
      <button type="button" onClick={() => reset()} className="btn-primary-sm">
        Try again
      </button>
    </div>
  );
}
