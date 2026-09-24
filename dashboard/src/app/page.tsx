import { redirect } from "next/navigation";

// The orders feed is the landing page; it sends signed-out visitors to /login.
export default function Home() {
  redirect("/orders");
}
