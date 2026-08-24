import { Chat } from "./Chat";

export default function GUI() {
  return (
    <div className="flex min-h-0 w-full flex-row overflow-x-hidden">
      <main className="no-scrollbar flex min-h-0 flex-1 flex-col">
        <Chat />
      </main>
    </div>
  );
}
