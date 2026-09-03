import ReviewWorkbench from "./review-workbench";
import "./review-workbench.css";
import "./manual-authority.css";

export default async function ReviewPage({searchParams}:{searchParams:Promise<{date?:string}>}){
  const params=await searchParams;
  return <ReviewWorkbench initialDate={params.date||""}/>;
}
