import Link from "next/link";

export const metadata = { title: "Page not found — JobTrackr" };

export default function NotFound() {
  return (
    <main className="min-h-screen bg-bg text-text-2 flex flex-col">
      <header className="border-b border-border px-6 py-4">
        <Link href="/" className="text-xl font-medium text-text hover:text-brand transition-colors tracking-tight">
          JobTrackr
        </Link>
      </header>

      <div className="flex-1 flex flex-col items-center justify-center px-6 py-24 text-center">
        <p className="text-sm font-medium text-text-3 mb-3">404</p>
        <h1 className="text-3xl font-medium text-text mb-3 tracking-tight">Page not found</h1>
        <p className="max-w-md text-base leading-relaxed">
          The page you&apos;re looking for doesn&apos;t exist or may have moved.
        </p>
        <Link
          href="/"
          className="mt-8 inline-flex items-center gap-1 text-sm font-medium text-brand hover:text-text transition-colors"
        >
          ← Back to home
        </Link>
      </div>
    </main>
  );
}
