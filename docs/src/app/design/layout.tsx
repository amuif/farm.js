import type { LayoutProps } from "@farm.js/core";
import { AnnouncementBar, SiteFooter, SiteHeader } from "../../components/site-chrome";
import "./design.css";

// The page content is page.md, which Farm also serves as raw markdown at /design.md.
export default function DesignLayout({ children }: LayoutProps) {
  return (
    <div className="farm-home farm-design min-h-screen overflow-x-clip bg-black font-sans text-white">
      <a className="design-skip-link" href="#design-content">
        Skip to content
      </a>
      <AnnouncementBar />
      <div className="farm-page-grid">
        <div aria-hidden className="farm-page-rail" />
        <div className="farm-page-content min-w-0">
          <SiteHeader />
          <main id="design-content" tabIndex={-1} className="design-main">
            <p className="design-source">
              <span aria-hidden="true">00</span> Design
              <a href="/design.md">design.md ↗</a>
            </p>
            <article className="design-prose">{children}</article>
          </main>
          <SiteFooter />
        </div>
        <div aria-hidden className="farm-page-rail" />
      </div>
    </div>
  );
}
