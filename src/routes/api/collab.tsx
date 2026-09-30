import { createFileRoute } from "@tanstack/react-router";
import {
  clientIp,
  currentUser,
  isAuthed,
  rateHit,
  rateLocked,
  tooMany,
  unauthorized,
} from "../../lib/hob.server";
import {
  addProspect,
  addProspectLog,
  addSignup,
  adminData,
  collabSettings,
  createLink,
  deleteLink,
  deleteProspect,
  deleteShopifyCode,
  deleteSignup,
  ensureDiscountCode,
  fixCodeCombinations,
  markCommissionPaid,
  parseSignup,
  prospectToLink,
  setCodeActive,
  setFileReceived,
  setHandledBy,
  updateCampaign,
  updateLinkNote,
  updateProspect,
  updateProspectStatus,
  updateReel,
  updateSignupStatus,
} from "../../lib/collab.server";

function bad(): Response {
  return Response.json({ ok: false, code: "bad_request" }, { status: 400 });
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export const Route = createFileRoute("/api/collab")({
  server: {
    handlers: {
      // Admin data for the board tab — authed only. Carries the actor (so the
      // tab can default the "who handles" chip) and the public-link settings.
      GET: async ({ request }) => {
        if (!(await isAuthed(request))) return unauthorized();
        const actor = (await currentUser(request))?.key ?? "";
        const s = await collabSettings(new URL(request.url).origin);
        return Response.json({
          ok: true,
          me: actor,
          settings: {
            base: s.base,
            storeUrl: s.storeUrl,
            discountPct: s.discountPct,
            commissionPct: s.commissionPct,
            instagram: s.instagram,
            brandName: s.brandName,
          },
          ...(await adminData()),
        });
      },

      POST: async ({ request }) => {
        let body: Record<string, unknown>;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return bad();
        }
        const action = typeof body.action === "string" ? body.action : "";

        // The ONE public action: a signup from the /c/<token> page.
        if (action === "signup") {
          const token = typeof body.token === "string" ? body.token : "";
          const input = parseSignup(body);
          if (!token || !input) return bad();
          // A person signs up once; a script signing up every second is not
          // a person. 6 per hour per address.
          const rk = `signup:${clientIp(request)}`;
          if (await rateLocked(rk, 6, 60)) return tooMany();
          await rateHit(rk, 60);
          const res = await addSignup(token, input);
          if (!res.ok) return Response.json(res, { status: 404 });
          return Response.json(res);
        }

        // Everything else manages the program — authed only. The actor comes
        // from the session, never from the client.
        if (!(await isAuthed(request))) return unauthorized();
        const actor = (await currentUser(request))?.key ?? "";
        const handled = typeof body.handled_by === "string" ? body.handled_by : actor;

        if (action === "create_link") {
          const campaignId = Number(body.campaignId);
          const name = typeof body.name === "string" ? body.name.trim() : "";
          const instagram =
            typeof body.instagram === "string" ? body.instagram.trim().replace(/^@/, "") : "";
          if (!Number.isFinite(campaignId) || !name) return bad();
          const rawProduct = Number(body.productId);
          const productId = Number.isFinite(rawProduct) && rawProduct > 0 ? rawProduct : null;
          const picks = Number(body.picks) || 1;
          const personal = typeof body.personal === "string" ? body.personal : "";
          const gender = body.gender === "m" || body.gender === "f" ? body.gender : "";
          const link = await createLink(
            campaignId,
            name,
            instagram,
            productId,
            picks,
            personal,
            body.generic === true,
            gender,
            handled,
          );
          // The store code is NOT minted here — it's created automatically
          // when the signup is approved (or manually from the tab), so the
          // store doesn't fill up with codes nobody used.
          return Response.json({ ok: true, link });
        }

        if (action === "set_handled_by") {
          const id = Number(body.id);
          const kind = body.kind === "prospect" ? "prospect" : body.kind === "link" ? "link" : null;
          if (!Number.isFinite(id) || !kind) return bad();
          await setHandledBy(kind, id, typeof body.who === "string" ? body.who : "");
          return Response.json({ ok: true });
        }

        if (action === "create_code") {
          const id = Number(body.id);
          if (!Number.isFinite(id)) return bad();
          return Response.json(await ensureDiscountCode(id));
        }

        // Ending a collaboration: the code stops working, nothing is deleted.
        if (action === "set_code_active") {
          const id = Number(body.id);
          if (!Number.isFinite(id)) return bad();
          return Response.json(await setCodeActive(id, body.active === true));
        }

        // Repair: let already-minted codes combine with the store's
        // automatic discounts. No id = every code still marked unfixed.
        if (action === "fix_combinations") {
          const id = Number(body.id);
          return Response.json(
            await fixCodeCombinations(Number.isFinite(id) && id > 0 ? id : undefined),
          );
        }

        if (action === "delete_code") {
          const code = typeof body.code === "string" ? body.code.trim() : "";
          if (!code) return bad();
          return Response.json(await deleteShopifyCode(code));
        }

        if (action === "update_link_note") {
          const id = Number(body.id);
          if (!Number.isFinite(id)) return bad();
          await updateLinkNote(id, typeof body.note === "string" ? body.note : "");
          return Response.json({ ok: true });
        }

        if (action === "delete_link") {
          const id = Number(body.id);
          if (!Number.isFinite(id)) return bad();
          await deleteLink(id);
          return Response.json({ ok: true });
        }

        if (action === "update_status") {
          const id = Number(body.id);
          const status = typeof body.status === "string" ? body.status : "";
          if (!Number.isFinite(id) || !(await updateSignupStatus(id, status))) return bad();
          return Response.json({ ok: true });
        }

        if (action === "commission_paid") {
          const id = Number(body.linkId);
          if (!Number.isFinite(id)) return bad();
          await markCommissionPaid(id);
          return Response.json({ ok: true });
        }

        if (action === "file_received") {
          const id = Number(body.id);
          if (!Number.isFinite(id)) return bad();
          await setFileReceived(id, body.value === true);
          return Response.json({ ok: true });
        }

        if (action === "delete_signup") {
          const id = Number(body.id);
          if (!Number.isFinite(id)) return bad();
          await deleteSignup(id);
          return Response.json({ ok: true });
        }

        if (action === "update_reel") {
          const id = Number(body.id);
          if (!Number.isFinite(id)) return bad();
          await updateReel(id, { reel_url: str(body.reel_url), reel_views: num(body.reel_views) });
          return Response.json({ ok: true });
        }

        // ---- Outreach prospects (manual) ----

        if (action === "add_prospect") {
          const name = typeof body.name === "string" ? body.name.trim() : "";
          if (!name) return bad();
          const res = await addProspect({
            name,
            instagram: str(body.instagram)?.trim() ?? "",
            followers: Number(body.followers) || 0,
            gender: str(body.gender) ?? "",
            niche: str(body.niche) ?? "",
            note: str(body.note) ?? "",
            handled_by: handled,
          });
          return Response.json(res);
        }

        if (action === "update_prospect") {
          const id = Number(body.id);
          if (!Number.isFinite(id)) return bad();
          await updateProspect(id, {
            name: str(body.name),
            instagram: str(body.instagram),
            followers: num(body.followers),
            gender: str(body.gender),
            niche: str(body.niche),
            note: str(body.note),
            personal: str(body.personal),
            next_step: str(body.next_step),
            followup_date: str(body.followup_date),
            size: str(body.size),
          });
          return Response.json({ ok: true });
        }

        if (action === "prospect_log") {
          const id = Number(body.id);
          if (!Number.isFinite(id)) return bad();
          const ok = await addProspectLog(id, typeof body.text === "string" ? body.text : "");
          return Response.json({ ok });
        }

        if (action === "prospect_status") {
          const id = Number(body.id);
          const status = typeof body.status === "string" ? body.status : "";
          if (!Number.isFinite(id) || !(await updateProspectStatus(id, status))) return bad();
          return Response.json({ ok: true });
        }

        if (action === "delete_prospect") {
          const id = Number(body.id);
          if (!Number.isFinite(id)) return bad();
          await deleteProspect(id);
          return Response.json({ ok: true });
        }

        if (action === "prospect_link") {
          const id = Number(body.id);
          const campaignId = Number(body.campaignId);
          if (!Number.isFinite(id) || !Number.isFinite(campaignId)) return bad();
          const link = await prospectToLink(id, campaignId, actor);
          if (!link) return bad();
          return Response.json({ ok: true, link });
        }

        if (action === "update_campaign") {
          const id = Number(body.id);
          if (!Number.isFinite(id)) return bad();
          await updateCampaign(id, {
            title: str(body.title),
            product_name: str(body.product_name),
            product_value: num(body.product_value),
            brief: str(body.brief),
            asks: str(body.asks),
          });
          return Response.json({ ok: true });
        }

        return bad();
      },
    },
  },
});
