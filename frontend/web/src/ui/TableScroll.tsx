/**
 * TableScroll — wraps a wide table / grid-row layout so it scrolls horizontally
 * on small screens instead of breaking the page layout. On mobile it bleeds to
 * the screen edges (-mx-4 + px-4) so the scroll area uses the full width; from
 * `sm` up it sits flush in its container.
 *
 * Pass `minWidth` (default 640px) to keep the inner content's column shape while
 * the user scrolls. Set to a falsy value to let the child size itself.
 */
export function TableScroll({
  children,
  minWidth = 640,
  className = "",
}: {
  children: React.ReactNode;
  minWidth?: number | false;
  className?: string;
}) {
  return (
    <div className={`overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 ${className}`}>
      <div style={minWidth ? { minWidth } : undefined}>{children}</div>
    </div>
  );
}
