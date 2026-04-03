'use client';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4">
      <img
        src="https://docs.lazysuperheroes.com/logo.svg"
        alt="Lazy Superheroes"
        className="mb-8 h-12"
      />
      <h1 className="font-heading text-2xl text-destructive">
        Something went wrong
      </h1>
      <p className="mt-2 max-w-md text-center text-muted">
        {error.message}
      </p>
      <button
        onClick={() => reset()}
        className="mt-6 rounded-lg bg-primary px-6 py-2.5 text-white transition-opacity hover:opacity-90"
      >
        Try Again
      </button>
    </div>
  );
}
