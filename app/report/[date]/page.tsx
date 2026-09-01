import DailyReportClient from "../../daily-report-client";

export default async function ReportPage({params}:{params:Promise<{date:string}>}){
  const {date}=await params;
  return <DailyReportClient requestedDate={date}/>;
}
