import { createFileRoute } from "@tanstack/react-router";
import { clientIp, db, isAuthed, rateHit, rateLocked, tooMany, unauthorized } from "../../lib/hob.server";
import { prospectRequest, recordOutcome, setSeedHandles, setVerdict } from "../../lib/partners.server";
import {
  addSignup,
  adminData,
  createLink,
  addProspect,
  deleteProspect,
  deleteShopifyCode,
  ensureDiscountCode,
  fixCodeCombinations,
  setCodeActive,
  prospectToLink,
  updateLinkNote,
  updateProspectStatus,
  updateReel,
  deleteLink,
  deleteSignup,
  parseSignup,
  updateCampaign,
  updateSignupStatus,
  markCommissionPaid,
  setFileReceived,
} from "../../lib/collab.server";

function bad(): Response {
  return Response.json({ ok: false, code: "bad_request" }, { status: 400 });
}

export const Route = createFileRoute("/api/collab")({
  server: {
    handlers: {
      // Admin data for the board tab — authed only.
      GET: async ({ request }) => {
        if (!(await isAuthed(request))) return unauthorized();
        return Response.json({ ok: true, ...(await adminData()) });
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

        // Everything else manages the program — authed only.
        if (!(await isAuthed(request))) return unauthorized();

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
          );
          // The Shopify code is NOT minted here — it's created automatically
          // when the influencer reaches 'posted' (or manually from the tab),
          // so the store doesn't fill up with codes nobody used.
          return Response.json({ ok: true, link });
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
          await updateReel(id, {
            reel_url: typeof body.reel_url === "string" ? body.reel_url : undefined,
            reel_views: typeof body.reel_views === "number" ? body.reel_views : undefined,
          });
          return Response.json({ ok: true });
        }

        if (action === "add_prospect") {
          const name = typeof body.name === "string" ? body.name.trim() : "";
          if (!name) return bad();
          const res = await addProspect({
            name,
            instagram: typeof body.instagram === "string" ? body.instagram.trim() : "",
            followers: Number(body.followers) || 0,
            gender: typeof body.gender === "string" ? body.gender : "",
            niche: typeof body.niche === "string" ? body.niche : "",
            note: typeof body.note === "string" ? body.note : "",
          });
          return Response.json(res);
        }

        if (action === "prospect_status") {
          const id = Number(body.id);
          const status = typeof body.status === "string" ? body.status : "";
          if (!Number.isFinite(id)) return bad();
          // שלבי המסלול עוברים דרך updateProspect (יומן + העברה למיכאלה); linked/rejected נשארים כמו שהיו.
          if (status === "linked" || status === "rejected") {
            if (!(await updateProspectStatus(id, status))) return bad();
            return Response.json({ ok: true });
          }
          // שלבי המסלול, אישור/עדכון/ביטול צילום: עדכון והעברה למיכאלה באותה טרנזקציה.
          // כשל חוזר כתשובה מלאה (200 + ok:false + הסבר), כדי שהכרטיס יציג אותו ולא "נשמר".
          return Response.json(await prospectRequest(db(), "prospect_status", body));
        }

        // ליה: הטעם של יוגב, עדכון פרטים, תוצאה בסיום, וידיות לבדיקה.
        if (action === "prospect_verdict") {
          const id = Number(body.id);
          const verdict = ["", "fit", "not_fit", "later"].includes(String(body.verdict)) ? (String(body.verdict) as "" | "fit" | "not_fit" | "later") : null;
          if (!Number.isFinite(id) || verdict === null) return bad();
          return Response.json({ ok: await setVerdict(db(), id, verdict, typeof body.reason === "string" ? body.reason : "") });
        }
        if (action === "prospect_update") {
          const id = Number(body.id);
          if (!Number.isFinite(id)) return bad();
          return Response.json(await prospectRequest(db(), "prospect_update", body));
        }
        if (action === "prospect_outcome") {
          const id = Number(body.id);
          if (!Number.isFinite(id)) return bad();
          return Response.json({ ok: await recordOutcome(db(), id, body.outcome) });
        }
        if (action === "seed_handles") {
          return Response.json({ ok: true, handles: await setSeedHandles(db(), typeof body.handles === "string" ? body.handles : "") });
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
          const link = await prospectToLink(id, campaignId);
          if (!link) return bad();
          return Response.json({ ok: true, link });
        }

        if (action === "update_campaign") {
          const id = Number(body.id);
          if (!Number.isFinite(id)) return bad();
          await updateCampaign(id, {
            product_name: typeof body.product_name === "string" ? body.product_name : undefined,
            product_value:
              typeof body.product_value === "number" ? body.product_value : undefined,
            brief: typeof body.brief === "string" ? body.brief : undefined,
            asks: typeof body.asks === "string" ? body.asks : undefined,
          });
          return Response.json({ ok: true });
        }

        return bad();
      },
    },
  },
});
