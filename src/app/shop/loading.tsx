export default function ShopLoading() {
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center p-8 bg-zinc-900 text-white">
      <div className="animate-pulse space-y-4 flex flex-col items-center">
        <div className="w-12 h-12 border-4 border-purple-500 border-t-transparent rounded-full animate-spin"></div>
        <div className="text-zinc-400 font-medium text-lg">Loading...</div>
      </div>
    </div>
  );
}
