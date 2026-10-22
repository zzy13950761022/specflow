export function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-xs font-medium transition ${
        active ? 'joule-gradient text-white' : 'text-joule-muted hover:text-joule-ink'
      }`}
    >
      {children}
    </button>
  );
}
