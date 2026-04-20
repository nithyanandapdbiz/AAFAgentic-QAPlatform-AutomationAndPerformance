import { useEffect, useState } from "react";
export default function App(){
  const [d,setD]=useState({});
  useEffect(()=>{ fetch("/api/dashboard").then(r=>r.json()).then(setD); },[]);
  return (<div><h1>QA Dashboard</h1>
    <p>Total: {d.total}</p>
    <p>Passed: {d.passed}</p>
    <p>Failed: {d.failed}</p>
  </div>);
}
